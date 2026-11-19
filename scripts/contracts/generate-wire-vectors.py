"""Deterministic transport fixtures • SYNTHETIC ONLY, no personal signing.

Uses the actual Python protocol implementation to pin the Rust wire format.
The PDF-looking bytes are deliberately not cryptographic validation fixtures.
Run with the pinned service Python environment from the repository root.
"""
from base64 import b64encode
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys
from uuid import UUID

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'apps/contract-signature-validator/src'))
sys.path.insert(0, str(ROOT / 'apps/contract-signature-service/src'))
from contract_signature_validator.model import (BaselineInventory, CheckResult, EvidenceSet,
    ExpectedSigner, PreflightBinding, PreflightReport, REQUIRED_INCREMENT_CHECKS,
    ValidationBinding, ValidationPolicy, ValidationReport, Verdict)
from contract_signature_validator.trust import load_trust_bundle
from contract_signature_validator.transport import ValidationRequest, encode_request
from contract_signature_validator.transport_auth import TransportAuthenticator
from contract_signature_service.bundle import encode_bundle, decode_bundle

NOW = datetime(2026, 11, 14, 12, 0, 0, tzinfo=timezone.utc)
KEY = b'SYNTHETIC-TRANSPORT-TEST-KEY-ONLY!!'
KEY_ID = 'test'
DESTINATION = ROOT / 'apps/api-ts/test/fixtures/contract-wire'


def main():
    DESTINATION.mkdir(parents=True, exist_ok=True)
    auth = TransportAuthenticator({KEY_ID: KEY})
    base = b'%PDF-SYNTHETIC-WIRE-ONLY-NOT-A-VALID-PDF'
    trust = load_trust_bundle((ROOT / 'deploy/fiscal/icp-brasil-roots.pem').read_bytes())
    evidence = EvidenceSet(NOW)
    for operation in ('preflight', 'increment'):
        values = dict(operation=operation, request_id=UUID('10000000-0000-4000-8000-000000000001'),
            tenant_id=UUID('20000000-0000-4000-8000-000000000001'),
            envelope_id=UUID('30000000-0000-4000-8000-000000000001'),
            document_id=UUID('40000000-0000-4000-8000-000000000001'),
            policy_sha256=ValidationPolicy().sha256, trust_bundle_sha256=trust.sha256, base=base)
        if operation == 'increment':
            values.update(parent=base+b'-PREVIOUS', candidate=base+b'-PREVIOUS-CANDIDATE',
                signer=ExpectedSigner(UUID('50000000-0000-4000-8000-000000000001'), '52998224725'),
                previous_signers=(ExpectedSigner(UUID('60000000-0000-4000-8000-000000000001'), '11144477735'),))
        request = ValidationRequest(**values)
        body = encode_request(request)
        headers = auth.headers_for(body, operation=operation, request_id=request.request_id,
                                   key_id=KEY_ID, sent_at=NOW)
        # Round trip through the same authenticated decoder used by the service.
        decoded = auth.decode_request(body, list(headers.items()), method='POST',
            target='/internal/v1/'+operation, now=NOW, policy_sha256=request.policy_sha256,
            trust_bundle_sha256=request.trust_bundle_sha256)
        assert decoded.request == request
        # Constructed model reports exercise transport/schema only. No PDF is
        # parsed or cryptographically accepted here; these are not ICP proofs.
        accepted = lambda name: CheckResult(name,Verdict.ACCEPTED,'protocol_fixture')
        if operation == 'preflight':
            base_hash=hashlib.sha256(base).hexdigest()
            report=PreflightReport(PreflightBinding(request.document_id,base_hash,request.policy_sha256,trust.sha256,NOW),
                tuple(accepted(name) for name in ('binding','format','baseline')),
                'icp_brasil',BaselineInventory(request.document_id,base_hash,len(base),request.policy_sha256,trust.sha256,()))
        else:
            report=ValidationReport(ValidationBinding(request.document_id,request.signer.participant_id,
                hashlib.sha256(request.parent).hexdigest(),hashlib.sha256(request.candidate).hexdigest(),request.policy_sha256,trust.sha256,NOW),
                tuple(accepted(name) for name in sorted(REQUIRED_INCREMENT_CHECKS)), 'icp_brasil')
        from dataclasses import replace
        report=replace(report,checks=report.checks+(CheckResult('evidence_set',Verdict.ACCEPTED,'typed_evidence_set_bound',(evidence.sha256,)),))
        response_body,response_headers=encode_bundle(decoded,report,evidence,trust,auth)
        result=decode_bundle(response_body,list(response_headers.items()),decoded,auth,trust_profile='icp_brasil',now=NOW)
        assert result.response['report']['verdict']=='accepted'
        payload = dict(syntheticOnly=True, purpose='transport interoperability, not ICP evidence',
            operation=operation, requestId=str(request.request_id), tenantId=str(request.tenant_id),
            envelopeId=str(request.envelope_id), documentId=str(request.document_id),
            policySha256=request.policy_sha256, trustBundleSha256=request.trust_bundle_sha256,
            keyId=KEY_ID, keyBase64=b64encode(KEY).decode('ascii'), sentAt=int(NOW.timestamp()),
            parts={name:b64encode(getattr(request,name)).decode('ascii') for name in request.part_names},
            signer=None if request.signer is None else dict(participantId=str(request.signer.participant_id),expectedCpf=request.signer.expected_cpf),
            previousSigners=[dict(participantId=str(s.participant_id),expectedCpf=s.expected_cpf) for s in request.previous_signers],
            frameBase64=b64encode(body).decode('ascii'), frameSha256=hashlib.sha256(body).hexdigest(), headers=headers,
            responseBundleBase64=b64encode(response_body).decode('ascii'),responseHeaders=response_headers,
            responseBundleSha256=result.sha256,evidenceSetSha256=evidence.sha256,
            registrySha256=trust.registry_sha256)
        (DESTINATION / (operation+'.json')).write_text(json.dumps(payload,sort_keys=True,indent=2)+'\n', encoding='ascii')
        print(operation, hashlib.sha256(body).hexdigest())


if __name__ == '__main__':
    main()
