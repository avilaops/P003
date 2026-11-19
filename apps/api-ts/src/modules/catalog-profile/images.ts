import { createHash } from "node:crypto"
import sharp from "sharp"
import type { AuthorizedContext } from "../../platform/access.js"
import type { CatalogMedia } from "../../platform/catalog-media.js"
import { Problem } from "../../platform/problem.js"

// Immutable photo versions. Originals remain private; derivatives keep their colors (lossless WebP).
type Asset = { variant: "webp" | "thumbnail" | "source"; filename: string; mediaType: string; bytes: Buffer; width: number; height: number }

const formats = {
  "data:image/jpeg;base64": { format: "jpeg", filename: "source.jpg", mediaType: "image/jpeg" },
  "data:image/png;base64": { format: "png", filename: "source.png", mediaType: "image/png" },
  "data:image/webp;base64": { format: "webp", filename: "source.webp", mediaType: "image/webp" },
} as const
const invalidPhoto = () => new Problem(422, "invalid_input", "Use uma foto JPG, PNG ou WebP de até 10 MB e 16 megapixels")

export async function preparePhoto(value: string): Promise<Asset[]> {
  const comma = value.indexOf(",")
  const declared = comma > 0 ? formats[value.slice(0, comma) as keyof typeof formats] : undefined
  const encoded = value.slice(comma + 1)
  if (!declared || encoded.length > 14_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw invalidPhoto()
  const original = Buffer.from(encoded, "base64")
  if (original.length === 0 || original.length > 10_000_000) throw invalidPhoto()
  const metadata = await sharp(original, { limitInputPixels: 16_000_000, failOn: "error" }).metadata().catch(() => { throw invalidPhoto() })
  const { width, height } = metadata
  if (metadata.format !== declared.format || !width || !height || width > 6000 || height > 6000 || width * height > 16_000_000) throw invalidPhoto()
  const assets: Asset[] = []
  for (const [variant, filename, size] of [["webp", "web.webp", 1600], ["thumbnail", "thumbnail.webp", 400]] as const) {
    const { data, info } = await sharp(original, { limitInputPixels: 16_000_000, failOn: "error" }).rotate()
      .resize(size, size, { fit: "inside", withoutEnlargement: true }).webp({ lossless: true })
      .toBuffer({ resolveWithObject: true }).catch(() => { throw invalidPhoto() })
    assets.push({ variant, filename, mediaType: "image/webp", bytes: data, width: info.width, height: info.height })
  }
  assets.push({ variant: "source", filename: declared.filename, mediaType: declared.mediaType, bytes: original, width, height })
  return assets
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

/** Uploads the photo versions and registers them; returns the media asset to present (the WebP derivative). */
export async function storePhoto(context: AuthorizedContext, gateway: CatalogMedia, productId: string, collection: string, value: string): Promise<string> {
  const assets = await preparePhoto(value)
  const sku = (await context.client.query<{ sku: string }>("SELECT sku FROM products WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [context.tenantId, productId])).rows[0]?.sku ?? ""
  if (!/^LD-[A-Z0-9-]+$/.test(sku)) throw new Problem(422, "invalid_input", "SKU não habilitado para a biblioteca")
  const originalHash = sha256(assets.find(asset => asset.variant === "source")!.bytes)
  const version = Number((await context.client.query<{ version: string }>("SELECT (COALESCE(MAX(version),0)+1)::text AS version FROM product_media_assets WHERE tenant_id=$1 AND product_id=$2", [context.tenantId, productId])).rows[0]!.version)
  let main: string | undefined
  for (const asset of assets) {
    const key = `ludus/catalogo/uploads/${originalHash}/${collection}/${sku}/${asset.filename}`
    const hash = sha256(asset.bytes)
    await gateway.upload(key, asset.mediaType, hash, asset.bytes)
    const storage = `r2://ludus-equipamentos-midias/${key}`
    await context.client.query("INSERT INTO system_config.files(tenant_id,storage_key,original_name,media_type,byte_size,sha256,status,created_by) SELECT $1,$2,$3,$4,$5,$6,'available',id FROM identities WHERE auth_subject=$7 ON CONFLICT(tenant_id,storage_key) DO NOTHING",
      [context.tenantId, storage, `${sku}-${asset.filename}`, asset.mediaType, asset.bytes.length, hash, context.authSubject])
    const fileId = (await context.client.query<{ id: string }>("SELECT id FROM system_config.files WHERE tenant_id=$1 AND storage_key=$2 AND sha256=$3 AND status='available'", [context.tenantId, storage, hash])).rows[0]?.id
    if (!fileId) throw new Problem(409, "domain_conflict", "Não foi possível registrar a foto no R2")
    await context.client.query("INSERT INTO system_config.file_versions(tenant_id,file_id,version,content_file_id) VALUES($1,$2,1,$2) ON CONFLICT DO NOTHING", [context.tenantId, fileId])
    const existing = (await context.client.query<{ id: string }>("SELECT id FROM product_media_assets WHERE tenant_id=$1 AND product_id=$2 AND file_id=$3 ORDER BY version DESC LIMIT 1", [context.tenantId, productId, fileId])).rows[0]?.id
    const mediaId = existing ?? (await context.client.query<{ id: string }>("INSERT INTO product_media_assets(tenant_id,product_id,file_id,collection,variant,version,width_px,height_px) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
      [context.tenantId, productId, fileId, collection, asset.variant, version, asset.width, asset.height])).rows[0]!.id
    if (asset.variant === "webp") main = mediaId
  }
  if (!main) throw new Problem(422, "invalid_input", "Imagem principal ausente")
  return main
}
