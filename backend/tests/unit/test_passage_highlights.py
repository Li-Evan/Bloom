import json
from tests.conftest import TestSession, seed_course
from app.models import Annotation, PassageHighlight

def test_highlight_is_persistent_isolated_and_removable(client, user, auth_headers, other_headers):
    cid, _ = seed_course(user.uuid)
    url = f'/api/courses/{cid}/lessons/1/highlights'
    data = dict(position_start=0, position_end=2, original_text='正文')
    with TestSession() as db:
        questions = db.query(Annotation).count()
    assert client.post(url, json=data).status_code == 401
    assert client.post(url, json=data, headers=other_headers).status_code == 404
    item = client.post(url, json=data, headers=auth_headers).json()
    assert client.post(url, json=data, headers=auth_headers).json()['id'] == item['id']
    assert client.get(url, headers=auth_headers).json() == [item]
    assert client.delete(f'{url}/{item["id"]}', headers=other_headers).status_code == 404
    with TestSession() as db:
        assert db.query(Annotation).count() == questions
        assert db.query(PassageHighlight).count() == 1
    assert client.delete(f'{url}/{item["id"]}', headers=auth_headers).status_code == 200
    assert client.get(url, headers=auth_headers).json() == []

def test_pdf_geometry_and_invalid_range(client, user, auth_headers):
    cid, _ = seed_course(user.uuid)
    url = f'/api/courses/{cid}/lessons/1/highlights'
    body = dict(position_start=0, position_end=2, original_text='正文', pdf_position=json.dumps({'page':1,'rects':[{'page':1,'x':0.1,'y':0.2,'w':0.2,'h':0.1}]}))
    assert client.post(url, json=body, headers=auth_headers).status_code == 200
    for patch in [{'position_end':-1}, {'original_text':' '}, {'user_uuid':'other'}, {'pdf_position':'{}'}, {'pdf_position':'[1]'}, {'pdf_position':'invalid'}]:
        assert client.post(url, json={**body, **patch}, headers=auth_headers).status_code == 422
