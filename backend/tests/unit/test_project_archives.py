import io
import stat
import time
import zipfile
from pathlib import Path

import pytest
from fastapi import HTTPException
from PIL import Image

from app import project_images
from app.config import settings
from app.models import Course, Lesson, ProjectImage
from app.project_archive import expand_uploads, rewrite_images
from tests.conftest import TestSession, bearer, create_user


def png():
    output = io.BytesIO()
    Image.new("RGB", (8, 8), "green").save(output, format="PNG")
    return output.getvalue()


def archive(files, *, finder_names=False):
    class FinderName(zipfile.ZipInfo):
        def _encodeFilenameFlags(self):
            return self.filename.encode("utf-8"), self.flag_bits & ~0x800

    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as z:
        for path, content in files:
            z.writestr(FinderName(path) if finder_names else path, content)
    return output.getvalue()


@pytest.fixture
def images(monkeypatch, tmp_path):
    """资料里的图片存成 IMAGE_STORE_DIR 下的文件：测试里指到临时目录，返回这个目录。"""
    store = tmp_path / "images"
    monkeypatch.setattr(settings, "IMAGE_STORE_DIR", str(store))
    return store


def stored(store):
    return sorted(path.name for path in store.iterdir()) if store.exists() else []


def test_zip_import_preserves_finder_unicode_and_images_without_extra_lessons(authed_client, user, images):
    raw = archive(
        [
            ("中文资料/中文文档.md", "# 正文\n\n![图](images/01.png)"),
            ("中文资料/images/01.png", png()),
            ("__MACOSX/._中文资料", b"junk"),
            ("中文资料/.DS_Store", b"junk"),
        ],
        finder_names=True,
    )
    response = authed_client.post("/api/courses/from-project", files={"files": ("资料.zip", raw)})
    assert response.status_code == 200, response.text
    course = response.json()
    assert course["lesson_count"] == 1 and course["name"] == "中文文档"
    assert course["skipped_files"] == [] and len(stored(images)) == 1
    with TestSession() as db:
        lesson = db.query(Lesson).filter_by(course_id=course["id"]).one()
        assert lesson.source_filename == "中文资料/中文文档.md"
        image = db.query(ProjectImage).one()
        image_id = image.id
        assert lesson.content == f"# 正文\n\n![图](/api/project-images/{image_id})"
        assert stored(images) == [image.object_key] and (images / image.object_key).read_bytes() == png()
    result = authed_client.get(f"/api/project-images/{image_id}")
    assert result.status_code == 200 and result.content == png()
    assert result.headers["content-type"] == "image/png"
    assert result.headers["cache-control"] == "private, max-age=31536000, immutable"
    other = bearer(create_user("other-images@bloom.test"))
    assert authed_client.get(f"/api/project-images/{image_id}", headers=other).status_code == 404
    assert authed_client.delete(f"/api/courses/{course['id']}").status_code == 200
    assert stored(images) == []
    with TestSession() as db:
        assert db.query(ProjectImage).count() == 0


def test_loose_folder_images_use_the_same_import_path_and_unreferenced_images_are_kept(authed_client, images):
    response = authed_client.post(
        "/api/courses/from-project",
        files=[
            ("files", ("folder/readme.md", b"# Notes")),
            ("files", ("folder/photo.png", png())),
        ],
    )
    assert response.status_code == 200 and response.json()["lesson_count"] == 2
    with TestSession() as db:
        contents = [row.content for row in db.query(Lesson).all()]
    assert any("![photo.png](/api/project-images/" in content for content in contents)


def test_image_only_project_has_a_readable_gallery(authed_client, images):
    response = authed_client.post("/api/courses/from-project", files={"files": ("photo.png", png())})
    assert response.status_code == 200 and response.json()["lesson_count"] == 1


@pytest.mark.parametrize("path", ["../escape.md", "/root.md", "C:\\evil.md", "dir/../escape.md"])
def test_zip_rejects_unsafe_paths_before_creating_any_course(authed_client, path):
    response = authed_client.post("/api/courses/from-project", files={"files": ("x.zip", archive([(path, "test")]))})
    assert response.status_code == 400
    with TestSession() as db:
        assert db.query(Course).count() == 0


def test_zip_size_file_count_duplicates_symlinks_and_nested_archives():
    def expand(raw, **kwargs):
        return expand_uploads(
            [("x.zip", raw)],
            max_files=kwargs.get("max_files", 50),
            max_file_bytes=kwargs.get("max_file_bytes", 1_000_000),
            max_total_bytes=kwargs.get("max_total_bytes", 2_000_000),
        )

    for raw, kwargs in [
        (archive([("a.md", "x" * 1000)]), {"max_file_bytes": 100}),
        (archive([("a.md", "x" * 600), ("b.md", "y" * 600)]), {"max_total_bytes": 1000}),
        (archive([("a.md", "x"), ("b.md", "y")]), {"max_files": 1}),
        (archive([("a.md", "x"), ("./a.md", "y")]), {}),
        (archive([("inner.zip", b"PK")]), {}),
        (b"not zip", {}),
    ]:
        with pytest.raises(HTTPException):
            expand(raw, **kwargs)
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as z:
        info = zipfile.ZipInfo("link.md")
        info.create_system = 3
        info.external_attr = (stat.S_IFLNK | 0o777) << 16
        z.writestr(info, "/etc/passwd")
    with pytest.raises(HTTPException):
        expand(output.getvalue())


def test_markdown_links_resolve_relative_names_without_touching_code_or_external_urls():
    source = """![inline](../images/a%20b.png "title")
![angle](<../images/a b.png>)
![ref][pic]
[pic]: ../images/a%20b.png "caption"
![external](https://example.com/a.png)
`![example](../images/a%20b.png)`
```markdown
![example](../images/a%20b.png)
```
"""
    result, used = rewrite_images(source, "root/docs/readme.md", {"root/images/a b.png": "/api/project-images/123"})
    assert result.count("/api/project-images/123") == 3
    assert used == {"root/images/a b.png"}
    assert '"title"' in result and '"caption"' in result
    assert "![external](https://example.com/a.png)" in result
    assert result.count("![example](../images/a%20b.png)") == 2
    nested, _ = rewrite_images("![x](images/a(b).png)", "r/readme.md", {"r/images/a(b).png": "/ok"})
    assert nested == "![x](/ok)"
    malformed = "![external](http://[invalid)"
    assert rewrite_images(malformed, "readme.md", {"image.png": "/ok"})[0] == malformed


def test_large_backtick_and_bracket_inputs_do_not_backtrack():
    start = time.monotonic()
    for content in ["`" * 1_000_000, "[" * 1_000_000]:
        assert rewrite_images(content, "readme.md", {"image.png": "/image"})[0] == content
    assert time.monotonic() - start < 2


def test_invalid_images_and_unwritable_storage_fail_without_partial_course(authed_client, monkeypatch, images, tmp_path):
    bad = authed_client.post("/api/courses/from-project", files={"files": ("bad.png", b"not image")})
    assert bad.status_code == 400 and not stored(images)
    blocked = tmp_path / "not-a-directory"
    blocked.write_text("")
    monkeypatch.setattr(settings, "IMAGE_STORE_DIR", str(blocked))
    response = authed_client.post("/api/courses/from-project", files={"files": ("x.png", png())})
    assert response.status_code == 503
    with TestSession() as db:
        assert db.query(Course).count() == 0


def test_failed_image_write_cleans_partial_images_and_keeps_retry_metadata_if_delete_fails(
    authed_client, monkeypatch, images
):
    write_bytes, unlink = Path.write_bytes, Path.unlink

    def failing_write(path, raw):
        write_bytes(path, raw)
        raise OSError("disk full")

    def failing_unlink(path, missing_ok=False):
        raise OSError("read-only file system")

    monkeypatch.setattr(Path, "write_bytes", failing_write)
    monkeypatch.setattr(Path, "unlink", failing_unlink)
    response = authed_client.post("/api/courses/from-project", files={"files": ("x.png", png())})
    assert response.status_code == 503 and len(stored(images)) == 1
    with TestSession() as db:
        assert db.query(Course).count() == 0
        image = db.query(ProjectImage).one()
        assert image.course_id is None
        monkeypatch.setattr(Path, "unlink", unlink)
        assert project_images.cleanup_images(db, [image.id]) == 1
        assert not stored(images) and db.query(ProjectImage).count() == 0
