const API_BASE = '/api';

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
    throw new Error(data.detail || `请求失败 (${res.status})`);
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

export async function createCourse(name, reference = '') {
  return apiRequest('/courses', {
    method: 'POST',
    body: JSON.stringify({ name, reference }),
  });
}

export async function createSourceCourse(name, file) {
  const formData = new FormData();
  formData.append('name', name);
  formData.append('file', file);

  const res = await fetch(`${API_BASE}/courses/from-source`, {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || `请求失败 (${res.status})`);
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
async function postSSE(path, body, onChunk, onDone) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || `请求失败 (${res.status})`);
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
export async function createAnnotation(courseId, lessonNum, data, onChunk, onDone) {
  return postSSE(`/courses/${courseId}/lessons/${lessonNum}/annotations`, data, onChunk, onDone);
}

// Follow-up question in a session; the answer streams via onChunk, updated annotation via onDone.
export async function addAnnotationMessage(courseId, lessonNum, annotationId, content, onChunk, onDone) {
  return postSSE(`/courses/${courseId}/lessons/${lessonNum}/annotations/${annotationId}/messages`, { content }, onChunk, onDone);
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
      throw new Error(data.detail || `请求失败 (${res.status})`);
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
