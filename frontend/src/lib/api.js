const API_BASE = '/api';

// FastAPI 422 的 detail 是数组（每项含 msg），直接 throw 会显示成 "[object Object]"；这里提取成可读文本。
function extractDetail(data, status) {
  const d = data?.detail;
  if (Array.isArray(d)) return d.map((e) => e?.msg || JSON.stringify(e)).join('；');
  return d || `请求失败 (${status})`;
}

export async function apiRequest(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(extractDetail(data, res.status));
  }

  return res.json();
}

// --- Courses ---

export async function getCourses() {
  return apiRequest('/courses');
}

export async function getCourse(courseId) {
  return apiRequest(`/courses/${courseId}`);
}

export async function createCourse(name, reference = '', learningDepth = 'standard') {
  return apiRequest('/courses', {
    method: 'POST',
    body: JSON.stringify({ name, reference, learning_depth: learningDepth }),
  });
}

export async function createSourceCourse(name, file, learningDepth = 'standard') {
  const formData = new FormData();
  formData.append('name', name);
  formData.append('learning_depth', learningDepth);
  formData.append('file', file);

  const res = await fetch(`${API_BASE}/courses/from-source`, {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(extractDetail(data, res.status));
  }

  return res.json();
}

// 上传一个或多个文件 / 整个文件夹作为「项目」：每个文件直接渲染、可随时划线提问。
export async function createProjectCourse(name, files) {
  const formData = new FormData();
  formData.append('name', name);
  for (const f of files) formData.append('files', f, f.webkitRelativePath || f.name);

  const res = await fetch(`${API_BASE}/courses/from-project`, {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(extractDetail(data, res.status));
  }

  return res.json();
}

export async function deleteCourse(courseId) {
  return apiRequest(`/courses/${courseId}`, { method: 'DELETE' });
}

// --- Syllabus ---

export async function getSyllabus(courseId) {
  return apiRequest(`/courses/${courseId}/syllabus`);
}

export async function updateSyllabus(courseId, content) {
  return apiRequest(`/courses/${courseId}/syllabus`, {
    method: 'PUT',
    body: JSON.stringify({ content }),
  });
}

// --- Lessons ---

export async function getLessons(courseId) {
  return apiRequest(`/courses/${courseId}/lessons`);
}

export async function getLesson(courseId, lessonNum) {
  return apiRequest(`/courses/${courseId}/lessons/${lessonNum}`);
}

// --- Annotations ---

export async function getAnnotations(courseId, lessonNum) {
  return apiRequest(`/courses/${courseId}/lessons/${lessonNum}/annotations`);
}

// Shared SSE reader for POST endpoints that stream `data: {...}` lines.
// Calls onChunk(text) per token and onDone(data) on the final event; throws on {error}.
async function postSSE(path, body, onChunk, onDone, signal) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(extractDetail(data, res.status));
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      let data;
      try { data = JSON.parse(line.slice(6)); } catch { continue; }
      if (data.error) throw new Error(data.error);
      if (data.content) onChunk(data.content);
      if (data.done && onDone) onDone(data);
    }
  }
}

// Create a highlight Q&A session; the answer streams via onChunk, final annotation via onDone.
export async function createAnnotation(courseId, lessonNum, data, onChunk, onDone, signal) {
  return postSSE(`/courses/${courseId}/lessons/${lessonNum}/annotations`, data, onChunk, onDone, signal);
}

// Follow-up question in a session; the answer streams via onChunk, updated annotation via onDone.
export async function addAnnotationMessage(courseId, lessonNum, annotationId, content, onChunk, onDone, signal) {
  return postSSE(`/courses/${courseId}/lessons/${lessonNum}/annotations/${annotationId}/messages`, { content }, onChunk, onDone, signal);
}

// Persist a Q&A round the user stopped mid-stream — keeps the partial answer, returns the saved annotation.
export async function saveInterruptedAnnotation(courseId, lessonNum, payload) {
  return apiRequest(`/courses/${courseId}/lessons/${lessonNum}/annotations/save`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function deleteAnnotation(courseId, lessonNum, annotationId) {
  return apiRequest(`/courses/${courseId}/lessons/${lessonNum}/annotations/${annotationId}`, {
    method: 'DELETE',
  });
}

// --- Feedback ---

export async function submitFeedback(courseId, lessonNum, content, thoughtAnswers) {
  return apiRequest(`/courses/${courseId}/lessons/${lessonNum}/feedback`, {
    method: 'POST',
    body: JSON.stringify({ content, thought_answers: thoughtAnswers }),
  });
}

// --- Generate Next Lesson (SSE streaming) ---

// Bound inactivity, not total generation time: long lessons can keep streaming
// for more than two minutes, especially with the context from previous lessons.
const LESSON_STREAM_IDLE_TIMEOUT_MS = 120000;

export async function generateNextLesson(courseId, onChunk, onDone) {
  const controller = new AbortController();
  let timeout;
  let timedOut = false;
  let reader;
  const resetIdleTimeout = () => {
    clearTimeout(timeout);
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, LESSON_STREAM_IDLE_TIMEOUT_MS);
  };

  try {
    resetIdleTimeout();
    const res = await fetch(`${API_BASE}/courses/${courseId}/next`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(extractDetail(data, res.status));
    }
    if (!res.body) throw new Error('服务器未返回生成内容，请稍后重试');

    resetIdleTimeout();
    reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const processLine = (line) => {
      if (!line.startsWith('data:')) return false;
      let data;
      try { data = JSON.parse(line.slice(5)); } catch { return false; }
      if (!data) return false;
      if (data.error) throw new Error(data.error);
      // Keep callback exceptions outside the JSON parse catch.
      if (data.content) onChunk(data.content);
      if (data.done) {
        if (onDone) onDone(data);
        return true;
      }
      return false;
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        if (processLine(buffer)) return;
        // EOF alone does not confirm that the backend saved the generated lesson.
        throw new Error('生成连接意外中断，未收到完成确认。请刷新课程查看是否已生成，再重试。');
      }
      // Any non-empty chunk (including SSE heartbeats) proves the stream is alive.
      if (value.byteLength > 0) resetIdleTimeout();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        // The backend sends done after committing; do not wait for socket closure.
        if (processLine(line)) return;
      }
    }
  } catch (err) {
    if (timedOut) {
      throw new Error('生成超时：连续 2 分钟未收到服务器数据。请刷新课程查看是否已生成，再重试。');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
    if (reader) {
      // Teardown must not delay navigation or replace the original stream error.
      reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

// --- Feedback GET ---

export async function getFeedback(courseId, lessonNum) {
  return apiRequest(`/courses/${courseId}/lessons/${lessonNum}/feedback`);
}

// --- Lesson Events ---

export async function recordLessonOpened(courseId, lessonNum) {
  return apiRequest(`/courses/${courseId}/lessons/${lessonNum}/opened`, {
    method: 'POST',
  });
}

// --- Stats ---

export async function getGlobalStats() {
  return apiRequest('/stats');
}

export async function getCourseStats(courseId) {
  return apiRequest(`/courses/${courseId}/stats`);
}

// --- Learning Calendar (个人中心) ---

export async function getCalendar() {
  return apiRequest('/calendar');
}

// --- Summary ---

export async function getSummary(courseId) {
  return apiRequest(`/courses/${courseId}/summary`);
}

// --- Recommendations ---

export async function getRecommendations() {
  return apiRequest('/recommendations');
}

export async function refreshRecommendations() {
  return apiRequest('/recommendations/refresh', { method: 'POST' });
}

export async function saveRecommendation(recommendationId) {
  return apiRequest(`/recommendations/${recommendationId}/save`, { method: 'POST' });
}

export async function removeSavedRecommendation(recommendationId) {
  return apiRequest(`/recommendations/${recommendationId}/save`, { method: 'DELETE' });
}

export async function startRecommendation(recommendationId, courseId) {
  return apiRequest(`/recommendations/${recommendationId}/start`, {
    method: 'POST',
    body: JSON.stringify({ course_id: courseId }),
  });
}
