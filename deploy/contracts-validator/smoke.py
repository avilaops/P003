"""Exercise the production entry points with a blank PDF and no business records."""
import base64
from datetime import datetime, timezone
from http.client import HTTPSConnection
from io import BytesIO
import json
from pathlib import Path
import ssl
from uuid import uuid4

from contract_signature_service.bundle import MAX_BYTES, decode_bundle
from contract_signature_service.config import load_config
from contract_signature_validator.transport import ValidationRequest, encode_request
from contract_signature_validator.transport_auth import TransportAuthenticator
from pyhanko.pdf_utils import generic, writer


def main():
    public = load_config(Path('/config/public'))
    key_id = 'gateway-1'
    key = json.loads(Path('/probe/hmac.json').read_bytes())['keys'][key_id]
    auth = TransportAuthenticator({key_id: base64.b64decode(key, validate=True)})
    doc = writer.PdfFileWriter()
    stream = doc.add_object(generic.StreamObject(stream_data=b'q Q'))
    doc.insert_page(writer.PageObject(contents=stream, media_box=(0,0,100,100), resources=generic.DictionaryObject()))
    pdf = BytesIO()
    doc.write(pdf)
    req = ValidationRequest('preflight', uuid4(), uuid4(), uuid4(), uuid4(), public.policy.sha256,
                            public.trust.sha256, pdf.getvalue())
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
        if result.response['report']['verdict'] != 'accepted' or result.response['report']['baseline']['signatures']:
            raise ValueError('unexpected_preflight_result')
    finally:
        connection.close()
    print('Private TLS, authenticated preflight, isolated worker and evidence bundle verified.')


if __name__ == '__main__':
    main()
