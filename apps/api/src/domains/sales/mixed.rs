//! Mixed-price negotiation uses the same authorization and immutable order lifecycle.
use super::{
    mixed_model::{self as model, MixedDirector, MixedSale, MixedSimulationInput, Policy},
    negotiation,
    negotiation_model::{ApprovalRules, SourceItem},
};
use crate::{
    domains::{
        DomainChange, DomainError, authorized, command_key, db, decimal, record, remember, replay,
        response,
    },
    platform::{access, auth::AuthenticatedIdentity, state::AppState},
};
use axum::{
    Extension, Json,
    extract::{State, rejection::JsonRejection},
    http::{HeaderMap, StatusCode},
    response::Response,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;
const READ: &str = "sales.orders.read";
const MANAGE: &str = "sales.orders.manage";
const DIRECTOR: &str = "sales.approvals.director";
const POLICY: &str = "platform.company.manage";

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MixedSimulation {
    tenant_id: Uuid,
    digest: String,
    sale: MixedSale,
    director: Option<MixedDirector>,
}
struct Prepared {
    sale: MixedSale,
    director: MixedDirector,
    rules: ApprovalRules,
    policies: Vec<Policy>,
    sources: Vec<SourceItem>,
    digest: String,
}
async fn prepare(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
    input: &MixedSimulationInput,
) -> Result<Prepared, DomainError> {
    if input.items.is_empty() || input.items.len() > 100 {
        return Err(DomainError::Invalid(
            "Simulação exige de 1 a 100 equipamentos",
        ));
    }
    let mut policies = Vec::<Policy>::new();
    let mut sources = Vec::new();
    for item in &input.items {
        if !matches!(item.line.as_str(), "imported" | "national") {
            return Err(DomainError::Invalid("Linha comercial inválida"));
        }
        if !policies
            .iter()
            .any(|p| p.line == item.line && p.version_id == item.version_id)
        {
            let(version,saved,current,policy):(i64,i64,i64,Value)=sqlx::query_as("SELECT v.version,v.settings_revision,s.revision,v.policy_snapshot FROM commercial_settings s JOIN price_table_versions v ON v.tenant_id=s.tenant_id AND v.id=s.active_price_version_id WHERE s.tenant_id=$1 AND s.product_line=$2 AND v.product_line=$2 AND v.id=$3")
                .bind(tenant).bind(&item.line).bind(item.version_id).fetch_optional(&mut **tx).await.map_err(db)?.ok_or(DomainError::StaleRevision)?;
            if saved != current {
                return Err(DomainError::Conflict(
                    "Parâmetros alterados após a publicação. Publique a tabela atualizada antes de simular",
                ));
            }
            policies.push(Policy {
                line: item.line.clone(),
                version_id: item.version_id,
                version,
                parameters: serde_json::from_value(policy)
                    .map_err(|_| access::AccessError::Internal)?,
            });
        }
        let source:SourceItem=sqlx::query_as("SELECT i.product_id,i.product_snapshot->>'sku' AS sku,i.product_snapshot->>'name' AS name,i.product_snapshot->>'unit' AS unit,p.revision AS product_revision,i.cost_revision,i.price_without_ipi_cents AS price_cents,(i.cost_snapshot->>'purchaseCostCents')::bigint AS purchase_cents,(i.cost_snapshot->>'taxCreditBps')::integer AS credit_bps,(i.cost_snapshot->>'packagingCents')::bigint AS packaging_cents FROM price_table_items i JOIN products p ON p.tenant_id=i.tenant_id AND p.id=i.product_id JOIN price_table_versions v ON v.tenant_id=i.tenant_id AND v.id=i.version_id LEFT JOIN product_costs c ON c.tenant_id=i.tenant_id AND c.product_id=i.product_id WHERE i.tenant_id=$1 AND i.version_id=$2 AND i.product_id=$3 AND p.status='active' AND v.product_line=$4 AND p.unit=i.product_snapshot->>'unit' AND p.revision=(i.product_snapshot->>'revision')::bigint AND ((v.source_kind='calculated' AND c.product_line=$4 AND c.revision=i.cost_revision) OR (v.source_kind='legacy' AND i.cost_revision IS NULL AND i.source_snapshot->>'source'=v.source_reference->>'source'))")
            .bind(tenant).bind(item.version_id).bind(item.product_id).bind(&item.line).fetch_optional(&mut **tx).await.map_err(db)?.ok_or(DomainError::Conflict("Produto ou custo alterado, indisponível ou fora da tabela. Atualize e publique a tabela"))?;
        sources.push(source);
    }
    let (rules_revision, rules) = negotiation::rules(tx, tenant).await?;
    let (sale, director) = model::calculate(input, &policies, &sources, &rules)?;
    let raw = json!({"tenantId":tenant,"input":input,"rulesRevision":rules_revision,"rules":rules,"policies":policies,"sources":sources,"sale":sale,"director":director});
    let digest = format!("{:x}", Sha256::digest(raw.to_string().as_bytes()));
    Ok(Prepared {
        sale,
        director,
        rules,
        policies,
        sources,
        digest,
    })
}

#[utoipa::path(post,path="/api/v1/commercial/mixed/simulate",operation_id="mixed_commercial_simulate",tag="Sales",request_body=MixedSimulationInput,security(("bearerAuth"=[])),params(("X-Tenant-Id"=Uuid,Header)),responses((status=200,body=MixedSimulation),(status=409,description="Políticas ou fontes incompatíveis"),(status=412,description="Tabela desatualizada")))]
pub async fn simulate(
    State(state): State<AppState>,
    Extension(identity): Extension<AuthenticatedIdentity>,
    headers: HeaderMap,
    payload: Result<Json<MixedSimulationInput>, JsonRejection>,
) -> Result<Response, DomainError> {
    let (tenant, mut tx, _) = authorized(&state, &headers, &identity, READ, MANAGE, false).await?;
    sqlx::query("SELECT id FROM tenants WHERE id=$1 FOR SHARE")
        .bind(tenant)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    let Json(input) =
        payload.map_err(|_| DomainError::Invalid("Simulação inválida ou campos desconhecidos"))?;
    let prepared = prepare(&mut tx, tenant, &input).await?;
    let director = if negotiation::allowed(&mut tx, tenant, &identity, POLICY).await?
        && negotiation::allowed(&mut tx, tenant, &identity, DIRECTOR).await?
    {
        Some(prepared.director)
    } else {
        None
    };
    tx.commit().await.map_err(db)?;
    Ok(response(
        StatusCode::OK,
        None,
        MixedSimulation {
            tenant_id: tenant,
            digest: prepared.digest,
            sale: prepared.sale,
            director,
        },
    ))
}

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MixedConvertInput {
    simulation: MixedSimulationInput,
    digest: String,
    customer_id: Uuid,
    due_date: String,
    checkout: Option<super::checkout::CheckoutInput>,
    opportunity_id: Option<Uuid>,
    opportunity_revision: Option<i64>,
}
#[utoipa::path(post,path="/api/v1/commercial/mixed/orders",operation_id="mixed_commercial_convert",tag="Sales",request_body=MixedConvertInput,security(("bearerAuth"=[])),params(("X-Tenant-Id"=Uuid,Header),("Idempotency-Key"=Uuid,Header)),responses((status=201,body=Value),(status=412,description="Simulação divergente")))]
pub async fn convert(
    State(state): State<AppState>,
    Extension(identity): Extension<AuthenticatedIdentity>,
    headers: HeaderMap,
    payload: Result<Json<MixedConvertInput>, JsonRejection>,
) -> Result<Response, DomainError> {
    let (tenant, mut tx, _) = authorized(&state, &headers, &identity, READ, MANAGE, true).await?;
    let key = command_key(&headers)?;
    let Json(input) =
        payload.map_err(|_| DomainError::Invalid("Conversão inválida ou campos desconhecidos"))?;
    let mut request = json!({"simulation":input.simulation,"digest":input.digest,"customerId":input.customer_id,"dueDate":input.due_date,"opportunityId":input.opportunity_id,"opportunityRevision":input.opportunity_revision});
    if let Some(checkout) = &input.checkout {
        request["checkout"] = json!(checkout);
    }
    if input.opportunity_id.is_some() != input.opportunity_revision.is_some() {
        return Err(DomainError::Invalid("Oportunidade exige sua revisão atual"));
    }
    if let Some(previous) = replay(
        &mut tx,
        tenant,
        &identity.subject,
        key,
        "mixed_negotiation.convert",
        &request,
    )
    .await?
    {
        tx.commit().await.map_err(db)?;
        return Ok(response(StatusCode::CREATED, Some(1), previous));
    }
    let prepared = prepare(&mut tx, tenant, &input.simulation).await?;
    if prepared.digest != input.digest {
        return Err(DomainError::StaleRevision);
    }
    let due = super::date(&input.due_date)?;
    let customer: (String,String) = sqlx::query_as("SELECT legal_name,tax_id FROM parties WHERE tenant_id=$1 AND id=$2 AND is_customer AND status='active'")
        .bind(tenant).bind(input.customer_id).fetch_optional(&mut *tx).await.map_err(db)?.ok_or(DomainError::Conflict("Selecione um cliente ativo desta empresa"))?;
    let mut lines = Vec::with_capacity(prepared.sale.items.len());
    for quoted in &prepared.sale.items {
        let item = &quoted.item;
        let product = crate::domains::catalog::load(&mut tx, tenant, item.product_id).await?;
        let structure_color = super::select_color(
            item.structure_color.as_deref(),
            product.data.structure_colors.as_deref().unwrap_or_default(),
            None,
        )?;
        let plate_holder_color = super::select_optional_color(
            item.plate_holder_color.as_deref(),
            product
                .data
                .plate_holder_colors
                .as_deref()
                .unwrap_or_default(),
            None,
        )?;
        let plate_holder_type =
            super::select_plate_holder_type(item.plate_holder_type.as_deref(), None)?;
        let upholstery_color = super::select_upholstery_color(
            item.upholstery_color.as_deref(),
            product
                .data
                .upholstery_colors
                .as_deref()
                .unwrap_or_default(),
            None,
            product.upholstery_configurable,
        )?;
        let swing_arm_color = super::select_swing_arm_color(
            item.swing_arm_color.as_deref(),
            product.data.swing_arm_colors.as_deref().unwrap_or_default(),
            None,
        )?;
        lines.push(super::PreparedLine {
            product_id: item.product_id,
            sku: item.sku.clone(),
            name: item.name.clone(),
            unit: item.unit.clone(),
            quantity: i64::from(item.quantity) * 1_000_000,
            price: item.unit_total_cents,
            amount: item.total_cents,
            structure_color,
            swing_arm_color,
            plate_holder_color,
            plate_holder_type,
            upholstery_color,
        });
    }
    let order = Uuid::now_v7();
    sqlx::query("INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$3,$4,$5,$6,$7,'draft')")
        .bind(order).bind(tenant).bind(input.customer_id).bind(customer.0).bind(customer.1).bind(due).bind(prepared.sale.total_cents).execute(&mut *tx).await.map_err(db)?;
    super::store_lines(&mut tx, tenant, order, &lines).await?;
    if let (Some(id), Some(expected)) = (input.opportunity_id, input.opportunity_revision) {
        super::opportunities::link_order(&mut tx, tenant, id, expected, input.customer_id, order)
            .await?;
        record(
            &mut tx,
            tenant,
            &identity,
            &headers,
            DomainChange {
                kind: "sales_opportunity",
                id,
                event: "opportunity.order_linked",
                details: json!({"orderId":order,"revision":expected+1}),
            },
        )
        .await?;
    }
    let auto = prepared.rules.director_auto_approval
        && negotiation::allowed(&mut tx, tenant, &identity, DIRECTOR).await?;
    let status = if prepared.sale.approval_reasons.is_empty() {
        "not_required"
    } else if auto {
        "approved"
    } else {
        "pending"
    };
    let public = json!({"kind":"mixed","input":input.simulation,"sale":prepared.sale,"digest":prepared.digest});
    let private = json!({"director":prepared.director,"policies":prepared.policies,"sources":prepared.sources});
    sqlx::query("INSERT INTO commercial_order_quotes(tenant_id,order_id,price_version_id,public_snapshot,private_snapshot,approval_rules,approval_status,requires_director,created_by) SELECT $1,$2,$3,$4,$5,$6,$7,$8,id FROM identities WHERE auth_subject=$9")
        .bind(tenant).bind(order).bind(Option::<Uuid>::None).bind(public).bind(private).bind(json!(prepared.rules)).bind(status).bind(prepared.director.requires_director).bind(&identity.subject).execute(&mut *tx).await.map_err(db)?;
    for policy in &prepared.policies {
        sqlx::query("INSERT INTO commercial_order_quote_versions(tenant_id,order_id,product_line,version_id,version_snapshot) VALUES($1,$2,$3,$4,$5)")
            .bind(tenant).bind(order).bind(&policy.line).bind(policy.version_id).bind(json!(policy)).execute(&mut *tx).await.map_err(db)?;
    }
    if let Some(checkout) = &input.checkout {
        super::checkout::save(
            &mut tx,
            tenant,
            order,
            input.customer_id,
            prepared.sale.total_cents,
            prepared.sale.down_payment_cents,
            checkout,
        )
        .await?;
    }
    if auto && status == "approved" {
        sqlx::query("INSERT INTO commercial_approval_decisions(id,tenant_id,order_id,order_revision,decision,reason,decided_by) SELECT $1,$2,$3,1,'approved','Autoaprovação da diretoria conforme política salva',id FROM identities WHERE auth_subject=$4").bind(Uuid::now_v7()).bind(tenant).bind(order).bind(&identity.subject).execute(&mut *tx).await.map_err(db)?;
    }
    record(&mut tx,tenant,&identity,&headers,DomainChange {kind:"sales_order",id:order,event:"order.created",details:json!({"revision":1,"priceVersions":prepared.policies.iter().map(|p|p.version_id).collect::<Vec<_>>(),"approvalStatus":status,"amount":decimal(prepared.sale.total_cents,2)})}).await?;
    let value = json!({"tenantId":tenant,"id":order,"revision":1,"approvalStatus":status});
    remember(
        &mut tx,
        tenant,
        &identity.subject,
        key,
        "mixed_negotiation.convert",
        &request,
        &value,
    )
    .await?;
    tx.commit().await.map_err(db)?;
    Ok(response(StatusCode::CREATED, Some(1), value))
}
