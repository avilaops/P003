import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import sharp from "sharp"

import { preparePhoto } from "../src/modules/catalog-profile/images.js"
import { missingFields } from "../src/modules/catalog-profile/pending.js"
import { validateCatalogInput } from "../src/modules/catalog-profile/routes.js"
import { createCatalogMedia } from "../src/platform/catalog-media.js"

const sheet = { collection: "core", muscleGroup: "Pernas e glúteos", technicalCategory: "Peso livre", dimensionsMm: [1200, 1000, 900], description: "", weight: "50 kg", weightStack: "", mainMediaId: null }

test("ficha técnica valida linha, grupo, dimensões e limites como a versão Rust", () => {
  assert.deepEqual(validateCatalogInput(sheet).dimensionsMm, [1200, 1000, 900])
  for (const broken of [
    { ...sheet, collection: "outlet" }, { ...sheet, muscleGroup: "  " }, { ...sheet, technicalCategory: "x".repeat(81) },
    { ...sheet, dimensionsMm: [0, 1000, 900] }, { ...sheet, dimensionsMm: [1200, 1000, 50001] }, { ...sheet, dimensionsMm: [1200, 1000] },
    { ...sheet, description: "x".repeat(4001) }, { ...sheet, weight: "x".repeat(81) }, { ...sheet, extra: true },
    (({ mainMediaId: _, ...rest }) => rest)(sheet),
  ]) assert.throws(() => validateCatalogInput(broken), /Confira linha, grupo e dimensões/)
})

test("dados do fabricante são aparados, limitados e sem caracteres de controle; omissão preserva", () => {
  const valid = validateCatalogInput({ ...sheet, manufacturer: "  DHZ Fitness  ", liveArea: "157*178 cm2" })
  assert.equal(valid.manufacturer, "DHZ Fitness")
  assert.equal(valid.manufacturerModel, undefined)
  assert.throws(() => validateCatalogInput({ ...sheet, manufacturer: "x".repeat(81) }), /Confira os dados do fabricante/)
  assert.throws(() => validateCatalogInput({ ...sheet, catalogProductName: "Nome\u0007" }), /Confira os dados do fabricante/)
})

test("fontes do catálogo exigem HTTPS sem credenciais, título e páginas válidas", () => {
  const source = { title: "Ludus Core", url: "https://drive.google.com/file/d/x/view#page=7", pdfPage: 7, printedPage: 7 }
  assert.equal(validateCatalogInput({ ...sheet, catalogSources: [source] }).catalogSources?.[0]?.title, "Ludus Core")
  assert.throws(() => validateCatalogInput({ ...sheet, catalogSources: [{ ...source, url: "http://example.com" }] }), /fonte/)
  assert.throws(() => validateCatalogInput({ ...sheet, catalogSources: [{ ...source, url: "https://user:pass@example.com" }] }), /fonte/)
  assert.throws(() => validateCatalogInput({ ...sheet, catalogSources: [{ ...source, title: " " }] }), /fonte/)
  assert.throws(() => validateCatalogInput({ ...sheet, catalogSources: [{ ...source, pdfPage: 0 }] }), /Confira linha/)
  assert.throws(() => validateCatalogInput({ ...sheet, catalogSources: Array.from({ length: 11 }, () => source) }), /até dez fontes/)
})

test("foto gera WebP de 1600 e 400 px sem perda de cor e preserva o original", async () => {
  const original = await sharp({ create: { width: 2000, height: 1000, channels: 4, background: { r: 20, g: 50, b: 230, alpha: 0.7 } } }).png().toBuffer()
  const assets = await preparePhoto(`data:image/png;base64,${original.toString("base64")}`)
  assert.deepEqual(assets.map(asset => [asset.variant, asset.width, asset.height, asset.mediaType]), [["webp", 1600, 800, "image/webp"], ["thumbnail", 400, 200, "image/webp"], ["source", 2000, 1000, "image/png"]])
  assert.ok(assets.find(asset => asset.variant === "source")!.bytes.equals(original))
  // Resizing premultiplies translucent pixels, so their channels may round by one; the alpha itself is kept.
  for (const asset of assets.filter(asset => asset.variant !== "source")) {
    const { data } = await sharp(asset.bytes).raw().toBuffer({ resolveWithObject: true })
    const [r, g, b, a] = [...data.subarray(0, 4)]
    assert.ok(Math.abs(r! - 20) <= 1 && Math.abs(g! - 50) <= 1 && Math.abs(b! - 230) <= 1 && a === 179, `${r},${g},${b},${a}`)
  }
  // Opaque photos, the usual equipment shot, keep the exact color through the lossless derivatives.
  const opaque = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: { r: 20, g: 50, b: 230 } } }).png().toBuffer()
  for (const asset of (await preparePhoto(`data:image/png;base64,${opaque.toString("base64")}`)).filter(asset => asset.variant !== "source")) {
    const { data, info } = await sharp(asset.bytes).raw().toBuffer({ resolveWithObject: true })
    assert.deepEqual([...data.subarray(0, 3)], [20, 50, 230], `canais ${info.channels}`)
  }
})

test("foto pequena não é ampliada e formatos falsos ou fora do limite são recusados", async () => {
  const small = await sharp({ create: { width: 300, height: 200, channels: 3, background: "#ffffff" } }).jpeg().toBuffer()
  assert.deepEqual((await preparePhoto(`data:image/jpeg;base64,${small.toString("base64")}`)).map(asset => asset.width), [300, 300, 300])
  await assert.rejects(preparePhoto("data:image/svg+xml;base64,PHN2Zz4="), /JPG, PNG ou WebP/)
  await assert.rejects(preparePhoto(`data:image/png;base64,${Buffer.from("not-a-photo").toString("base64")}`), /JPG, PNG ou WebP/)
  await assert.rejects(preparePhoto(`data:image/png;base64,${small.toString("base64")}`), /JPG, PNG ou WebP/)
  const huge = await sharp({ create: { width: 6001, height: 10, channels: 3, background: "#000000" } }).png().toBuffer()
  await assert.rejects(preparePhoto(`data:image/png;base64,${huge.toString("base64")}`), /JPG, PNG ou WebP/)
})

test("canal do catálogo envia foto com hash e lê objeto privado dentro do limite", async () => {
  const calls: { url: string; init?: RequestInit }[] = []
  const media = createCatalogMedia({ origin: "https://ludusequipamentos.com", token: "t".repeat(40), tenantId: "tenant" }, async (url, init) => {
    calls.push({ url: String(url), ...(init ? { init } : {}) })
    return String(url).includes("_private") ? new Response(new Uint8Array([1, 2, 3])) : new Response(null, { status: 204 })
  })
  const bytes = new Uint8Array([9, 8, 7])
  const hash = createHash("sha256").update(bytes).digest("hex")
  await media.upload("ludus/catalogo/uploads/abc/core/LD-WH001/web.webp", "image/webp", hash, bytes)
  assert.equal(calls[0]!.url, "https://ludusequipamentos.com/midias/_upload/abc/core/LD-WH001/web.webp")
  assert.equal(new Headers(calls[0]!.init?.headers).get("x-content-sha256"), hash)
  assert.equal(new Headers(calls[0]!.init?.headers).get("authorization"), `Bearer ${"t".repeat(40)}`)
  assert.equal(calls[0]!.init?.redirect, "error")
  await assert.rejects(media.upload("outra/pasta/arquivo.webp", "image/webp", hash, bytes), /Localizador de imagem inválido/)
  assert.deepEqual([...await media.readPrivate("v1/core/LD-WH001/source.png")], [1, 2, 3])
  assert.equal(calls.at(-1)!.url, "https://ludusequipamentos.com/midias/_private/v1/core/LD-WH001/source.png")
  const failing = createCatalogMedia({ origin: "https://ludusequipamentos.com", token: "t".repeat(40), tenantId: "tenant" }, async () => new Response(null, { status: 500 }))
  await assert.rejects(failing.readPrivate("v1/a.png"), /Imagem indisponível/)
  await assert.rejects(failing.upload("ludus/catalogo/uploads/a.webp", "image/webp", hash, bytes), /Não foi possível registrar a foto no R2/)
})

test("pendências listam só o que está vazio, sem deduzir valores", () => {
  const complete = { id: "a", sku: "LD-WH001", name: "Banco", ncm: "95069100", has_profile: true, manufacturer: "Fabricante", manufacturer_model: "M1", description: "Texto", live_area: "5 m²", weight: "50 kg", dimensions_mm: [1, 2, 3], has_photo: true }
  assert.deepEqual(missingFields(complete), [])
  assert.deepEqual(missingFields({ ...complete, manufacturer: "  ", live_area: "", dimensions_mm: [1200, 0, 900], has_photo: false }), ["manufacturer", "liveArea", "dimensions", "photo"])
  assert.deepEqual(missingFields({ ...complete, has_profile: false, manufacturer: null, manufacturer_model: null, description: null, live_area: null, weight: null, dimensions_mm: null, ncm: null }),
    ["catalogSheet", "manufacturer", "manufacturerModel", "description", "liveArea", "weight", "dimensions", "ncm"])
})
