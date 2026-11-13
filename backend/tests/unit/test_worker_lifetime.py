import threading

from app.courses import _worker_stream


def test_a_disconnected_stream_does_not_stop_the_worker_before_it_finishes():
    released = threading.Event()
    finished = threading.Event()

    def job():
        yield "first chunk"
        released.wait(5)
        finished.set()

    try:
        stream = _worker_stream(job, "test-worker-lifetime")
        assert next(stream) == "first chunk"
        stream.close()  # 客户端断开：只停止转发
        assert not finished.is_set()
        released.set()
        assert finished.wait(2)  # 后台线程照样跑完
    finally:
        released.set()


def test_worker_runs_to_completion():
    assert list(_worker_stream(lambda: iter(["a", "b"]), "test-local-lifetime")) == ["a", "b"]
