//! Personal ICP workflow, separate from historical DocuSeal completion.
mod bundle;
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "Identity boundary is connected to runtime in workflow plan task 3; remove this expectation then"
    )
)]
pub mod identity;
mod result_report;
mod transport;
mod trust;
mod wire_json;
