use super::*;
use crate::platform::commercial_settings_model::tests::example;
use legacy::ManagerLimit;
fn fixture() -> (
    MixedSimulationInput,
    Vec<Policy>,
    Vec<SourceItem>,
    ApprovalRules,
) {
    let mut policies = Vec::new();
    let mut items = Vec::new();
    let mut sources = Vec::new();
    for (index, line) in ["imported", "national"].iter().enumerate() {
        let id = Uuid::from_u128(index as u128 + 1);
        let version = Uuid::from_u128(index as u128 + 11);
        let mut p = example();
        p.ipi_bps = if index == 0 { 1300 } else { 0 };
        p.fixed_order_fee_cents = 101;
        p.minimum_down_payment_bps = if index == 0 { 7000 } else { 3000 };
        policies.push(Policy {
            line: (*line).into(),
            version_id: version,
            version: 1,
            parameters: p,
        });
        items.push(MixedItem {
            line: (*line).into(),
            version_id: version,
            product_id: id,
            quantity: 3,
            structure_color: None,
            swing_arm_color: None,
            plate_holder_color: None,
            plate_holder_type: None,
            upholstery_color: None,
        });
        sources.push(SourceItem {
            product_id: id,
            sku: format!("TEST-{index}"),
            name: format!("Equipamento {index}"),
            unit: "UN".into(),
            product_revision: 1,
            cost_revision: Some(1),
            price_cents: if index == 0 { 30001 } else { 17003 },
            purchase_cents: 1000,
            credit_bps: 0,
            packaging_cents: 0,
        });
    }
    (
        MixedSimulationInput {
            destination_state: "SP".into(),
            taxpayer: false,
            discount: Discount::Percent(0),
            freight_cents: 103,
            down_payment_cents: None,
            items,
        },
        policies,
        sources,
        ApprovalRules {
            below_target: true,
            freight: false,
            director_auto_approval: false,
            manager_limit: ManagerLimit::Profit,
        },
    )
}
#[test]
fn different_ipi_entry_rates_and_unique_fixed_costs_conserve_every_cent() {
    let (input, p, s, r) = fixture();
    let (sale, d) = calculate(&input, &p, &s, &r).unwrap();
    assert_eq!(sale.total_cents, 152715);
    assert_eq!(sale.details["ipiBps"], Value::Null);
    assert_eq!(sale.details["minimumDownPaymentBps"], Value::Null);
    assert_eq!(
        sale.items.iter().map(|i| i.item.total_cents).sum::<i64>(),
        sale.total_cents
    );
    assert_eq!(
        sale.policy_groups
            .iter()
            .map(|g| g["freightCents"].as_u64().unwrap())
            .sum::<u64>(),
        103
    );
    assert_eq!(
        d.details["policyGroups"]
            .as_array()
            .unwrap()
            .iter()
            .map(|g| g["director"]["fixedFeeCents"].as_u64().unwrap())
            .sum::<u64>(),
        101
    );
    assert_eq!(d.details["fixedFeeCents"], 101);
    let public = serde_json::to_string(&sale).unwrap();
    assert!(!public.contains("fixedOrderFeeCents"));
    assert!(!public.contains("fixedFeeCents"));
    assert_eq!(
        sale.down_payment_cents,
        sale.policy_groups
            .iter()
            .map(|g| g["minimumDownPaymentCents"].as_i64().unwrap())
            .sum::<i64>()
    );
}
#[test]
fn amount_and_percent_share_global_ratio_and_total_never_exceeds_requested() {
    let (mut input, p, s, r) = fixture();
    input.discount = Discount::Percent(1000);
    let (percent, _) = calculate(&input, &p, &s, &r).unwrap();
    input.discount = Discount::Amount(14101);
    let (amount, _) = calculate(&input, &p, &s, &r).unwrap();
    assert_eq!(percent.total_cents, amount.total_cents);
    input.discount = Discount::Total(120000);
    let (total, _) = calculate(&input, &p, &s, &r).unwrap();
    assert!(total.total_cents <= 120000);
    for item in total.items {
        assert_eq!(
            item.item.total_cents,
            item.item.unit_total_cents * i64::from(item.item.quantity)
        );
        assert_eq!(
            item.item.net_cents,
            item.item.unit_net_cents * i64::from(item.item.quantity)
        );
    }
}
#[test]
fn incompatible_fixed_fees_and_duplicate_products_are_rejected() {
    let (mut input, mut p, s, r) = fixture();
    p[1].parameters.fixed_order_fee_cents += 1;
    assert!(matches!(
        calculate(&input, &p, &s, &r),
        Err(DomainError::Conflict(_))
    ));
    p[1].parameters.fixed_order_fee_cents -= 1;
    input.items[1].product_id = input.items[0].product_id;
    assert!(calculate(&input, &p, &s, &r).is_err());
}
#[test]
fn loss_in_one_policy_requires_director_even_when_aggregate_profitable() {
    let (input, p, mut s, r) = fixture();
    s[1].purchase_cents = 20000;
    let (sale, d) = calculate(&input, &p, &s, &r).unwrap();
    assert!(d.requires_director);
    assert!(sale.approval_reasons.contains(&"fora-da-meta".into()));
    assert!(d.details["netProfitCents"].as_i64().unwrap() > 0);
}
#[test]
fn single_policy_mixed_route_matches_legacy_totals_and_entry() {
    let (mut input, mut p, mut s, r) = fixture();
    input.items.truncate(1);
    p.truncate(1);
    s.truncate(1);
    let (a, _) = calculate(&input, &p, &s, &r).unwrap();
    let legacy_input = SimulationInput {
        line: p[0].line.clone(),
        version_id: p[0].version_id,
        destination_state: input.destination_state.clone(),
        taxpayer: input.taxpayer,
        discount: input.discount.clone(),
        freight_cents: input.freight_cents,
        down_payment_cents: input.down_payment_cents,
        items: input.items.iter().map(MixedItem::legacy).collect(),
    };
    let (b, _) = legacy::calculate(&p[0].parameters, &r, &legacy_input, &s).unwrap();
    assert_eq!(
        (a.total_cents, a.net_sale_cents, a.down_payment_cents),
        (b.total_cents, b.net_sale_cents, b.down_payment_cents)
    );
}
