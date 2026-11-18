// Wire shapes from the published DraftInput contract. Domain checks run before persistence and signing.
import { z } from "zod"

const xmlAccessSchema = z.strictObject({
  name: z.string().nullable().optional(),
  taxId: z.string(),
})

const environmentSchema = z.enum(["homologation", "production"])

const exportationSchema = z.strictObject({
  dispatchLocation: z.string().nullable().optional(),
  exitState: z.string().nullable().optional(),
  exportLocation: z.string().nullable().optional(),
  kind: z.string(),
})

const goodsOriginSchema = z.enum(["national", "imported"])

const ibptItemSelectionSchema = z.strictObject({
  ex: z.string(),
  origin: goodsOriginSchema,
  version: z.string().nullable().optional(),
})

const ibptSelectionSchema = z.strictObject({
  asOf: z.string(),
  items: z.array(ibptItemSelectionSchema).max(990),
  uf: z.string(),
})

const installmentSchema = z.strictObject({
  amount: z.string(),
  dueDate: z.string(),
  number: z.string(),
})

const intermediarySchema = z.strictObject({
  registration: z.string(),
  taxId: z.string(),
})

const exportDetailSchema = z.strictObject({
  drawbackNumber: z.string().nullable().optional(),
  exportRegistration: z.string().nullable().optional(),
  exportedQuantity: z.string().nullable().optional(),
  referencedAccessKey: z.string().nullable().optional(),
})

const referencedDfeSchema = z.strictObject({
  accessKey: z.string(),
  itemNumber: z.number().int().min(0).nullable().optional(),
})

const draftItemSchema = z.strictObject({
  additionalInfo: z.string().nullable().optional(),
  cfop: z.string(),
  code: z.string(),
  cofinsCst: z.string(),
  csosn: z.string().nullable().optional(),
  description: z.string(),
  discountAmount: z.string().nullable().optional(),
  exportDetails: z.array(exportDetailSchema).max(990).optional(),
  freightAmount: z.string().nullable().optional(),
  grossTotal: z.string(),
  icmsCst: z.string().nullable().optional(),
  insuranceAmount: z.string().nullable().optional(),
  ncm: z.string(),
  origin: z.number().int().min(0),
  otherAmount: z.string().nullable().optional(),
  pisCst: z.string(),
  quantity: z.string(),
  referencedDfe: referencedDfeSchema.nullable().optional(),
  taxableQuantity: z.string().nullable().optional(),
  taxableUnit: z.string().nullable().optional(),
  taxableUnitPrice: z.string().nullable().optional(),
  unit: z.string(),
  unitPrice: z.string(),
})

const draftPaymentSchema = z.strictObject({
  amount: z.string(),
  code: z.string(),
  description: z.string().nullable().optional(),
})

const recipientSchema = z.strictObject({
  cityName: z.string().nullable().optional(),
  complement: z.string().nullable().optional(),
  countryCode: z.string().nullable().optional(),
  countryName: z.string().nullable().optional(),
  district: z.string(),
  email: z.string().nullable().optional(),
  foreignId: z.string().nullable().optional(),
  legalName: z.string(),
  municipalityCode: z.string(),
  number: z.string(),
  phone: z.string().nullable().optional(),
  postalCode: z.string(),
  state: z.string(),
  street: z.string(),
  taxId: z.string(),
})

const retentionsSchema = z.strictObject({
  cofins: z.string().nullable().optional(),
  csll: z.string().nullable().optional(),
  incomeTax: z.string().nullable().optional(),
  incomeTaxBase: z.string().nullable().optional(),
  pis: z.string().nullable().optional(),
  socialSecurity: z.string().nullable().optional(),
  socialSecurityBase: z.string().nullable().optional(),
})

const simplifiedDanfeSchema = z.strictObject({
  accessKeyUrl: z.string(),
  qrCodeUrl: z.string(),
})

const ibsCbsDeclarationSchema = z.strictObject({
  cbsRate: z.string(),
  classCode: z.string(),
  cst: z.string(),
  ibsCityRate: z.string(),
  ibsStateRate: z.string(),
})

const taxpayerIndicatorSchema = z.enum(["1", "2", "9"])

const taxDeclarationSchema = z.strictObject({
  cofinsRate: z.string().nullable().optional(),
  destinationFcpRate: z.string().nullable().optional(),
  destinationIcmsRate: z.string().nullable().optional(),
  finalConsumer: z.boolean(),
  ibsCbs: ibsCbsDeclarationSchema,
  icmsOutOfContributions: z.boolean(),
  icmsRate: z.string().nullable().optional(),
  ipiCst: z.string().nullable().optional(),
  ipiFrameCode: z.string().nullable().optional(),
  ipiInIcmsBase: z.boolean(),
  ipiRate: z.string().nullable().optional(),
  pisRate: z.string().nullable().optional(),
  recipientStateRegistration: z.string().nullable().optional(),
  recipientTaxpayer: z.boolean(),
  recipientTaxpayerIndicator: taxpayerIndicatorSchema.nullable().optional(),
})

const transportSchema = z.strictObject({
  address: z.string().nullable().optional(),
  brand: z.string().nullable().optional(),
  carrierName: z.string().nullable().optional(),
  carrierTaxId: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  grossWeight: z.string().nullable().optional(),
  netWeight: z.string().nullable().optional(),
  plate: z.string().nullable().optional(),
  rntc: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  stateRegistration: z.string().nullable().optional(),
  vehicleState: z.string().nullable().optional(),
  volumeKind: z.string().nullable().optional(),
  volumeNumber: z.string().nullable().optional(),
  volumes: z.number().int().min(0).nullable().optional(),
})

export const draftInputSchema = z.strictObject({
  additionalInformation: z.string().nullable().optional(),
  authorizedXml: z.array(xmlAccessSchema).max(990).optional(),
  changeAmount: z.string().nullable().optional(),
  creditType: z.string().nullable().optional(),
  crt: z.number().int().min(0).nullable().optional(),
  debitType: z.string().nullable().optional(),
  departureAt: z.string().nullable().optional(),
  emissionType: z.string().nullable().optional(),
  environment: environmentSchema,
  exportation: exportationSchema.nullable().optional(),
  finalConsumer: z.boolean().nullable().optional(),
  financialCategoryId: z.guid().nullable().optional(),
  freightMode: z.string().nullable().optional(),
  ibpt: ibptSelectionSchema.nullable().optional(),
  installments: z.array(installmentSchema).max(990).optional(),
  intermediary: intermediarySchema.nullable().optional(),
  issuedAt: z.string().nullable().optional(),
  items: z.array(draftItemSchema).max(990),
  model: z.number().int().min(0),
  number: z.number().int().min(0).nullable().optional(),
  operationNature: z.string(),
  paymentTerms: z.string().nullable().optional(),
  payments: z.array(draftPaymentSchema).max(990).nullable().optional(),
  presenceIndicator: z.number().int().min(0).nullable().optional(),
  printType: z.number().int().min(0).nullable().optional(),
  productsTotal: z.string(),
  purpose: z.number().int().min(0).optional(),
  recipient: recipientSchema,
  referencedAccessKeys: z.array(z.string()).max(990).optional(),
  retentions: retentionsSchema.nullable().optional(),
  returnDirection: z.string().nullable().optional(),
  salesperson: z.string().nullable().optional(),
  series: z.number().int().min(0).nullable().optional(),
  simplifiedDanfe: simplifiedDanfeSchema.nullable().optional(),
  sourceOrderId: z.guid().nullable().optional(),
  sourceReturnId: z.guid().nullable().optional(),
  sourceReturnKind: z.string().nullable().optional(),
  taxAuthorityInformation: z.string().nullable().optional(),
  taxDeclaration: taxDeclarationSchema.nullable().optional(),
  taxRuleReference: z.string(),
  transport: transportSchema.nullable().optional(),
})

export type DraftInput = z.infer<typeof draftInputSchema>
