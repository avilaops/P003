"""Exercise the production entry points with a blank PDF and no business records."""
import base64
from datetime import datetime, timedelta, timezone
from http.client import HTTPSConnection
from io import BytesIO
import json
from pathlib import Path
import ssl
from uuid import uuid4
from asn1crypto import keys, x509 as asn1_x509
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from contract_signature_service.bundle import MAX_BYTES, decode_bundle
from contract_signature_service.config import load_config
from contract_signature_validator.transport import ValidationRequest, encode_request
from contract_signature_validator.transport_auth import TransportAuthenticator
from pyhanko.pdf_utils import generic, writer
from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
from pyhanko.sign import fields, signers
from pyhanko_certvalidator.registry import SimpleCertificateStore


def technical_sample():
    # Preflight requires the provider's existing signature. Use an in-memory,
    # disposable technical seal on a blank page, with no e-CPF or real contract.
    doc = writer.PdfFileWriter()
    stream = doc.add_object(generic.StreamObject(stream_data=b'q Q'))
    doc.insert_page(writer.PageObject(contents=stream, media_box=(0,0,100,100), resources=generic.DictionaryObject()))
    pdf = BytesIO()
    doc.write(pdf)
    seal = rsa.generate_private_key(public_exponent=65537,key_size=2048)
    name = x509.Name([x509.NameAttribute(x509.NameOID.COMMON_NAME,'Disposable technical preflight sample')])
    observed = datetime.now(timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(seal.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(observed-timedelta(minutes=5))
            .not_valid_after(observed+timedelta(hours=1)).sign(seal,hashes.SHA256()))
    signer = signers.SimpleSigner(asn1_x509.Certificate.load(cert.public_bytes(serialization.Encoding.DER)),
        keys.PrivateKeyInfo.load(seal.private_bytes(serialization.Encoding.DER,serialization.PrivateFormat.PKCS8,
                                                    serialization.NoEncryption())),SimpleCertificateStore())
    output = BytesIO()
    signers.PdfSigner(signers.PdfSignatureMetadata(field_name='TechnicalSmoke',md_algorithm='sha256'),
                      signer,new_field_spec=fields.SigFieldSpec('TechnicalSmoke')).sign_pdf(
        IncrementalPdfFileWriter(BytesIO(pdf.getvalue())),output=output)
    return output.getvalue()


def main():
    public = load_config(Path('/config/public'))
    key_id = 'gateway-1'
    key = json.loads(Path('/probe/hmac.json').read_bytes())['keys'][key_id]
    auth = TransportAuthenticator({key_id: base64.b64decode(key, validate=True)})
    req = ValidationRequest('preflight', uuid4(), uuid4(), uuid4(), uuid4(), public.policy.sha256,
                            public.trust.sha256, technical_sample())
    body = encode_request(req)
    now = lambda: datetime.now(timezone.utc)
    headers = auth.headers_for(body, operation='preflight', request_id=req.request_id, key_id=key_id, sent_at=now())
    target = '/internal/v1/preflight'
    expected = auth.decode_request(body,list(headers.items()),method='POST',target=target,now=now(),
                                   policy_sha256=public.policy.sha256,trust_bundle_sha256=public.trust.sha256)
    connection = HTTPSConnection('contract-signature-gateway',8443,context=ssl.create_default_context(cafile='/probe/tls-ca.pem'),timeout=55)
    try:
        connection.request('POST',target,body,headers)
        response = connection.getresponse()
        if response.status != 200:
            raise ValueError('gateway_not_ready')
        result = decode_bundle(response.read(MAX_BYTES+1),response.getheaders(),expected,auth,trust_profile='icp_brasil',now=now())
        if result.response['report']['verdict'] != 'accepted' or len(result.response['report']['baseline']['signatures']) != 1:
            raise ValueError('unexpected_preflight_result')
    finally:
        connection.close()
    print('Private TLS, authenticated preflight, isolated worker and evidence bundle verified.')


if __name__ == '__main__':
    main()
