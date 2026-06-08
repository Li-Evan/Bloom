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

export async function generateNextLesson(courseId, onChunk, onDone) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000); // 2 min timeout

  try {
    const res = await fetch(`${API_BASE}/courses/${courseId}/next`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
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
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.content) onChunk(data.content);
            if (data.done && onDone) onDone(data);
            if (data.error) throw new Error(data.error);
          } catch (e) {
            if (!(e instanceof SyntaxError)) throw e;
          }
        }
      }
    }
  } finally {
    clearTimeout(timeout);
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
