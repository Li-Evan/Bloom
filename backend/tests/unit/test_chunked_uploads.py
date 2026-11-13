import hashlib
from datetime import datetime, timedelta, timezone

from tests.conftest import create_user, bearer, TestSession
from app.models import UploadSession, UploadPart
from app.uploads import CHUNK_BYTES, MAX_ACTIVE_UPLOADS, cleanup_expired


def start(client, headers, data, name='notes.txt'):
    return client.post('/api/uploads', headers=headers, json={'files': [
        {'name': name, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}]})


def send(client, headers, uid, data):
    for i in range(max(1, (len(data) + CHUNK_BYTES - 1) // CHUNK_BYTES)):
        r = client.put(f'/api/uploads/{uid}/files/0/parts/{i}', headers=headers, content=data[i*CHUNK_BYTES:(i+1)*CHUNK_BYTES])
        assert r.status_code == 200, r.text


def test_large_upload_reaches_material_extraction(client, monkeypatch):
    from app import courses
    headers = bearer(create_user('large@example.com'))
    data = b'Large source text\n' * 1_000_000
    uid = start(client, headers, data).json()['id']
    send(client, headers, uid, data)
    seen = []
    def extract(raw, filename, language):
        seen.append((filename, raw))
        from fastapi import HTTPException
        raise HTTPException(400, 'test stopped before paid generation')
    monkeypatch.setattr(courses, '_material_sections_from_bytes', extract)
    r = client.post('/api/courses/from-materials', headers=headers, data={'upload_id': uid, 'name': 'large'})
    assert r.status_code == 400 and seen == [('notes.txt', data)]
    with TestSession() as db:
        assert db.query(UploadSession).count() == db.query(UploadPart).count() == 0
    assert client.post('/api/courses/from-materials', headers=headers, data={'upload_id': uid, 'name': 'large'}).status_code == 404


def test_isolation_retry_integrity_and_missing_parts(client):
    a = bearer(create_user('a@example.com')); b = bearer(create_user('b@example.com'))
    data = b'x' * (CHUNK_BYTES + 2)
    uid = start(client, a, data).json()['id']
    path = f'/api/uploads/{uid}/files/0/parts/0'
    assert client.put(path, headers=b, content=data[:CHUNK_BYTES]).status_code == 404
    assert client.delete(f'/api/uploads/{uid}', headers=b).status_code == 404
    assert client.post('/api/courses/from-materials', headers=b, data={'upload_id': uid, 'name': 'x'}).status_code == 404
    assert client.post('/api/courses/from-materials', headers=a, data={'upload_id': uid, 'name': 'x'}).status_code == 400
    send(client, a, uid, data)
    assert client.put(path, headers=a, content=data[:CHUNK_BYTES]).status_code == 200
    assert client.put(path, headers=a, content=b'y'*CHUNK_BYTES).status_code == 409
    assert client.put(path, headers=a, content=b'x'*(CHUNK_BYTES+1)).status_code == 413
    assert client.put(f'/api/uploads/{uid}/files/0/parts/2', headers=a, content=b'').status_code == 400
    assert client.delete(f'/api/uploads/{uid}', headers=a).status_code == 200


def test_checksum_quota_expiry_and_auth(client):
    h = bearer(create_user('quota@example.com'))
    assert start(client, {}, b'x').status_code == 401
    uid = start(client, h, b'hello').json()['id']
    send(client, h, uid, b'wrong')
    assert client.post('/api/courses/from-materials', headers=h, data={'upload_id':uid, 'name':'x'}).status_code == 400
    for _ in range(MAX_ACTIVE_UPLOADS - 1): assert start(client, h, b'x').status_code == 200
    too_many = start(client, h, b'x')
    assert too_many.status_code == 429 and f'你还有 {MAX_ACTIVE_UPLOADS} 个未完成的上传' in too_many.json()['detail']
    with TestSession() as db:
        db.query(UploadSession).update({'expires_at':datetime.now(timezone.utc).replace(tzinfo=None)-timedelta(seconds=1)});db.commit()
        assert cleanup_expired(db) == MAX_ACTIVE_UPLOADS
        assert db.query(UploadPart).count() == 0
    assert start(client, h, b'x').status_code == 200


def test_project_large_pdf_streams_back_and_materials_keep_small_upload_compatibility(client, monkeypatch):
    from app import courses
    h = bearer(create_user('project@example.com'))
    raw = b'%PDF-' + b'x' * (5 * CHUNK_BYTES)
    monkeypatch.setattr(courses, '_extract_pdf_text', lambda data, name, *args, **kwargs: 'PDF text')
    uid = start(client, h, raw, 'folder/large.pdf').json()['id']
    send(client, h, uid, raw)
    response = client.post('/api/courses/from-project', headers=h, data={'upload_id':uid})
    assert response.status_code == 200, response.text
    course = response.json()['id']
    download = client.get(f'/api/courses/{course}/lessons/1/file', headers=h)
    assert download.status_code == 200 and download.content == raw
    assert download.headers['content-type'] == 'application/pdf'
    assert 'content-length' not in download.headers  # streamed, never buffered into a platform-sized response
    small = client.post('/api/courses/from-project', headers=h, files={'files':('readme.md',b'# Hello')})
    assert small.status_code == 200
