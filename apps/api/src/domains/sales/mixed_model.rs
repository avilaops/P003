//! Mixed published policies with a common rational discount and exact allocation.
use super::negotiation_model::{
    self as legacy, ApprovalRules, Discount, QuotedLine, SimulationInput, SimulationItem,
    SourceItem,
};
use crate::{domains::DomainError, platform::commercial_settings_model::CommercialParameters};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MixedItem {
    pub line: String,
    pub version_id: Uuid,
    pub product_id: Uuid,
    pub quantity: u32,
    pub structure_color: Option<String>,
    pub swing_arm_color: Option<String>,
    pub plate_holder_color: Option<String>,
    pub plate_holder_type: Option<String>,
    pub upholstery_color: Option<String>,
}
impl MixedItem {
    fn legacy(&self) -> SimulationItem {
        SimulationItem {
            product_id: self.product_id,
            quantity: self.quantity,
            structure_color: self.structure_color.clone(),
            swing_arm_color: self.swing_arm_color.clone(),
            plate_holder_color: self.plate_holder_color.clone(),
            plate_holder_type: self.plate_holder_type.clone(),
            upholstery_color: self.upholstery_color.clone(),
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MixedSimulationInput {
    pub destination_state: String,
    pub taxpayer: bool,
    pub discount: Discount,
    pub freight_cents: u64,
    pub down_payment_cents: Option<u64>,
    pub items: Vec<MixedItem>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Policy {
    pub line: String,
    pub version_id: Uuid,
    pub version: i64,
    pub parameters: CommercialParameters,
}
#[derive(Debug, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MixedQuotedLine {
    #[serde(flatten)]
    pub item: QuotedLine,
    pub line: String,
    pub version_id: Uuid,
    pub ipi_bps: u32,
}
#[derive(Debug, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MixedSale {
    pub calculator_version: String,
    pub items: Vec<MixedQuotedLine>,
    pub total_cents: i64,
    pub net_sale_cents: i64,
    pub down_payment_cents: i64,
    pub approval_reasons: Vec<String>,
    pub policy_groups: Vec<Value>,
    #[serde(flatten)]
    pub details: serde_json::Map<String, Value>,
}
#[derive(Debug, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MixedDirector {
    pub requires_director: bool,
    #[serde(flatten)]
    pub details: serde_json::Map<String, Value>,
}

fn cents(value: i128) -> Result<i64, DomainError> {
    if !(0..=99_999_999_999_999).contains(&value) {
        Err(DomainError::Invalid("Valor comercial fora do limite"))
    } else {
        Ok(value as i64)
    }
}
fn round(n: i128, d: i128) -> i128 {
    (n + d / 2) / d
}
fn up(n: i128, d: i128) -> i128 {
    (n + d - 1) / d
}
fn allocation(value: u64, weights: &[i128]) -> Vec<u64> {
    let sum: i128 = weights.iter().sum();
    let mut amounts: Vec<u64> = weights
        .iter()
        .map(|w| (i128::from(value) * w / sum) as u64)
        .collect();
    let mut order: Vec<_> = (0..weights.len()).collect();
    order.sort_by_key(|&i| (std::cmp::Reverse(i128::from(value) * weights[i] % sum), i));
    let remainder = value - amounts.iter().sum::<u64>();
    for &i in order.iter().take(remainder as usize) {
        amounts[i] += 1;
    }
    amounts
}
fn common(values: impl Iterator<Item = u32>) -> Option<u32> {
    let values: Vec<_> = values.collect();
    values
        .first()
        .copied()
        .filter(|first| values.iter().all(|v| v == first))
}

fn core(
    input: &MixedSimulationInput,
    policies: &[Policy],
    sources: &[SourceItem],
    rules: &ApprovalRules,
) -> Result<(MixedSale, MixedDirector), DomainError> {
    if input.items.is_empty()
        || input.items.len() > 100
        || sources.len() != input.items.len()
        || policies.is_empty()
        || policies.len() > 2
        || input.freight_cents > 1_000_000_000_000
    {
        return Err(DomainError::Invalid(
            "Informe de 1 a 100 equipamentos e um frete válido",
        ));
    }
    for p in policies {
        p.parameters.simulate()?;
        if p.parameters.fixed_order_fee_cents != policies[0].parameters.fixed_order_fee_cents {
            return Err(DomainError::Conflict(
                "As tabelas publicadas possuem taxas fixas diferentes. Ajuste e publique uma política comum antes de misturar as tabelas",
            ));
        }
    }
    let mut seen = std::collections::HashSet::new();
    let mut table = 0i128;
    let mut groups = vec![Vec::new(); policies.len()];
    for (index, (item, source)) in input.items.iter().zip(sources).enumerate() {
        if item.product_id != source.product_id
            || !seen.insert(item.product_id)
            || !(1..=1_000_000).contains(&item.quantity)
            || source.price_cents <= 0
        {
            return Err(DomainError::Invalid("Equipamento ou quantidade inválidos"));
        }
        let group = policies
            .iter()
            .position(|p| p.line == item.line && p.version_id == item.version_id)
            .ok_or(DomainError::Invalid("Origem comercial inválida"))?;
        groups[group].push(index);
        table += i128::from(source.price_cents) * i128::from(item.quantity);
    }
    if groups.iter().any(Vec::is_empty) {
        return Err(DomainError::Invalid("Política sem itens"));
    }
    cents(table)?;
    let total_at = |numerator: i128, denominator: i128| -> i128 {
        groups
            .iter()
            .enumerate()
            .map(|(g, indexes)| {
                indexes
                    .iter()
                    .map(|&i| {
                        up(
                            round(i128::from(sources[i].price_cents) * numerator, denominator)
                                * i128::from(10_000 + policies[g].parameters.ipi_bps),
                            10_000,
                        ) * i128::from(input.items[i].quantity)
                    })
                    .sum::<i128>()
            })
            .sum()
    };
    let (num, den) = match input.discount {
        Discount::Percent(bps) if bps < 10_000 => (i128::from(10_000 - bps), 10_000),
        Discount::Amount(amount) if i128::from(amount) < table => {
            (table - i128::from(amount), table)
        }
        Discount::Total(total) if total > 0 && i128::from(total) <= total_at(1, 1) => {
            let (mut low, mut high) = (0, table);
            while low < high {
                let mid = (low + high + 1) / 2;
                if total_at(mid, table) <= i128::from(total) {
                    low = mid;
                } else {
                    high = mid - 1;
                }
            }
            (low, table)
        }
        _ => {
            return Err(DomainError::Invalid(
                "Desconto deve preservar uma venda positiva e não superar a tabela",
            ));
        }
    };
    let mut normalized = sources.to_vec();
    for source in &mut normalized {
        source.price_cents = cents(round(i128::from(source.price_cents) * num, den))?;
        if source.price_cents == 0 {
            return Err(DomainError::Invalid(
                "Desconto deixa um equipamento sem valor comercial",
            ));
        }
    }
    let weights: Vec<i128> = groups
        .iter()
        .map(|indexes| {
            indexes
                .iter()
                .map(|&i| {
                    i128::from(normalized[i].price_cents) * i128::from(input.items[i].quantity)
                })
                .sum()
        })
        .collect();
    let freight = allocation(input.freight_cents, &weights);
    let fees = allocation(policies[0].parameters.fixed_order_fee_cents, &weights);
    let mut items: Vec<Option<MixedQuotedLine>> = std::iter::repeat_with(|| None)
        .take(sources.len())
        .collect();
    let mut public_groups = Vec::new();
    let mut private_groups = Vec::new();
    let mut reasons = Vec::new();
    let (mut net, mut ipi, mut total, mut minimum_entry, mut required_entry) =
        (0i128, 0i128, 0i128, 0i128, 0i128);
    let mut needs_director = false;
    let mut money_totals = std::collections::BTreeMap::<&str, i128>::new();
    for (g, indexes) in groups.iter().enumerate() {
        let policy = &policies[g];
        let mut p = policy.parameters.clone();
        p.fixed_order_fee_cents = fees[g];
        p.free_discount_bps = 0;
        let group_input = SimulationInput {
            line: policy.line.clone(),
            version_id: policy.version_id,
            destination_state: input.destination_state.clone(),
            taxpayer: input.taxpayer,
            discount: Discount::Percent(0),
            freight_cents: freight[g],
            down_payment_cents: None,
            items: indexes.iter().map(|&i| input.items[i].legacy()).collect(),
        };
        let group_sources: Vec<_> = indexes.iter().map(|&i| normalized[i].clone()).collect();
        let (mut sale, mut director) = legacy::calculate(&p, rules, &group_input, &group_sources)?;
        let group_table: i128 = indexes
            .iter()
            .map(|&i| i128::from(sources[i].price_cents) * i128::from(input.items[i].quantity))
            .sum();
        let free_net: i128 = indexes
            .iter()
            .map(|&i| {
                round(
                    i128::from(sources[i].price_cents)
                        * i128::from(10_000 - policy.parameters.free_discount_bps),
                    10_000,
                ) * i128::from(input.items[i].quantity)
            })
            .sum();
        if i128::from(sale.net_sale_cents) < free_net {
            sale.approval_reasons.push("desconto-acima-do-livre".into());
        }
        // Limits are measured against the original published prices, never the
        // transformed discounted sources used to reuse the legacy fiscal core.
        let original_sources: Vec<_> = indexes.iter().map(|&i| sources[i].clone()).collect();
        let mut bound_p = policy.parameters.clone();
        bound_p.fixed_order_fee_cents = fees[g];
        let (_, bounds) = legacy::calculate(&bound_p, rules, &group_input, &original_sources)?;
        director.maximum_at_target_discount_bps = bounds.maximum_at_target_discount_bps;
        director.maximum_no_loss_discount_bps = bounds.maximum_no_loss_discount_bps;
        net += i128::from(sale.net_sale_cents);
        ipi += i128::from(sale.ipi_cents);
        total += i128::from(sale.total_cents);
        minimum_entry += i128::from(sale.minimum_down_payment_cents);
        required_entry += i128::from(director.required_down_payment_cents);
        needs_director |= director.requires_director;
        for reason in &sale.approval_reasons {
            if !reasons.contains(reason) {
                reasons.push(reason.clone());
            }
        }
        let director_value = serde_json::to_value(&director).expect("serializable quote");
        for key in [
            "taxesCents",
            "difalCents",
            "equipmentCostCents",
            "fixedFeeCents",
            "profitBeforeIncomeTaxCents",
            "incomeTaxCents",
            "netProfitCents",
            "supplierPaymentCents",
            "targetProfitCents",
            "downPaymentCommissionCents",
            "minimumAtTargetCents",
        ] {
            *money_totals.entry(key).or_default() +=
                i128::from(director_value[key].as_i64().expect("quote money"));
        }
        public_groups.push(json!({"line":policy.line,"versionId":policy.version_id,"version":policy.version,"ipiBps":policy.parameters.ipi_bps,"freeDiscountBps":policy.parameters.free_discount_bps,"minimumDownPaymentBps":policy.parameters.minimum_down_payment_bps,"tableTotalCents":cents(group_table)?,"netSaleCents":sale.net_sale_cents,"ipiCents":sale.ipi_cents,"totalCents":sale.total_cents,"minimumDownPaymentCents":sale.minimum_down_payment_cents,"freightCents":freight[g],"approvalReasons":sale.approval_reasons}));
        private_groups
            .push(json!({"line":policy.line,"versionId":policy.version_id,"director":director}));
        for (&index, mut line) in indexes.iter().zip(sale.items) {
            line.table_unit_cents = sources[index].price_cents;
            items[index] = Some(MixedQuotedLine {
                item: line,
                line: policy.line.clone(),
                version_id: policy.version_id,
                ipi_bps: policy.parameters.ipi_bps,
            });
        }
    }
    let entry = input
        .down_payment_cents
        .map(i128::from)
        .unwrap_or(minimum_entry);
    if entry > total {
        return Err(DomainError::Invalid(
            "Entrada não pode superar o total da venda",
        ));
    }
    if entry < minimum_entry {
        reasons.push("entrada-abaixo-da-politica".into());
    }
    let details = json!({"tableTotalCents":cents(table)?,"discountCents":cents(table-net)?,"discountBps":round((table-net)*10_000,table),"ipiBps":common(policies.iter().map(|p|p.parameters.ipi_bps)),"ipiCents":cents(ipi)?,"freeDiscountBps":policies.iter().map(|p|p.parameters.free_discount_bps).min(),"minimumDownPaymentBps":common(policies.iter().map(|p|p.parameters.minimum_down_payment_bps)),"minimumDownPaymentCents":cents(minimum_entry)?,"requiredDownPaymentCents":cents(required_entry)?,"freightCents":input.freight_cents,"maximumAtTargetDiscountBps":null});
    let profit = money_totals["netProfitCents"];
    let band = if needs_director
        && private_groups
            .iter()
            .any(|g| g["director"]["band"] == "loss")
    {
        "loss"
    } else if private_groups
        .iter()
        .any(|g| g["director"]["band"] != "atTarget")
    {
        "belowTarget"
    } else {
        "atTarget"
    };
    let tax_bps = common(
        private_groups
            .iter()
            .map(|g| g["director"]["taxBps"].as_u64().expect("tax rate") as u32),
    );
    let difal_bps = common(
        private_groups
            .iter()
            .map(|g| g["director"]["difalBps"].as_u64().expect("difal rate") as u32),
    );
    let mut private = json!({"policyGroups":private_groups,"band":band,"targetBps":common(policies.iter().map(|p|p.parameters.net_margin_bps)),"taxBps":tax_bps,"difalBps":difal_bps,"netProfitBps":profit*10_000/net,"requiredDownPaymentCents":cents(required_entry)?,"requiredDownPaymentBps":up(required_entry*10_000,total),"maximumAtTargetDiscountBps":null,"maximumNoLossDiscountBps":null});
    for (key, value) in money_totals {
        if !(-99_999_999_999_999..=99_999_999_999_999).contains(&value) {
            return Err(DomainError::Invalid("Valor gerencial fora do limite"));
        }
        private[key] = json!(value as i64);
    }
    Ok((
        MixedSale {
            calculator_version: "ludus-mixed-order-v1-integer-cents".into(),
            items: items.into_iter().map(Option::unwrap).collect(),
            total_cents: cents(total)?,
            net_sale_cents: cents(net)?,
            down_payment_cents: cents(entry)?,
            approval_reasons: reasons,
            policy_groups: public_groups,
            details: details.as_object().unwrap().clone(),
        },
        MixedDirector {
            requires_director: needs_director,
            details: private.as_object().unwrap().clone(),
        },
    ))
}

pub(super) fn calculate(
    input: &MixedSimulationInput,
    policies: &[Policy],
    sources: &[SourceItem],
    rules: &ApprovalRules,
) -> Result<(MixedSale, MixedDirector), DomainError> {
    let (mut sale, mut director) = core(input, policies, sources, rules)?;
    for (name, target) in [
        ("maximumAtTargetDiscountBps", true),
        ("maximumNoLossDiscountBps", false),
    ] {
        let allowed = |bps| {
            let mut probe = input.clone();
            probe.discount = Discount::Percent(bps);
            probe.down_payment_cents = None;
            core(&probe, policies, sources, rules)
                .ok()
                .is_some_and(|(_, d)| {
                    d.details["policyGroups"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .all(|g| {
                            if target {
                                g["director"]["band"] == "atTarget"
                            } else {
                                g["director"]["netProfitCents"].as_i64().unwrap() >= 0
                            }
                        })
                })
        };
        let (mut low, mut high) = (0_u32, 9999_u32);
        if allowed(0) {
            while low < high {
                let mid = (low + high).div_ceil(2);
                if allowed(mid) {
                    low = mid;
                } else {
                    high = mid - 1;
                }
            }
        }
        director.details.insert(name.into(), json!(low));
        if target {
            sale.details.insert(name.into(), json!(low));
        }
    }
    Ok((sale, director))
}

#[cfg(test)]
#[path = "mixed_model_tests.rs"]
mod tests;
