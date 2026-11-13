import test from 'node:test';
import assert from 'node:assert/strict';
import { courseKnowledgeMap, courseTopicCount } from '../src/lib/learn/knowledge-courses.ts';

const source = (course_id, lesson_number = 1) => ({ course_id, lesson_number, course_name: `课程${course_id}`, lesson_title: '已读课文', quote: '原文中的实际内容。' });
const topic = (id, owners) => ({ id, label: id, summary: '已读内容', domain: 'mathematics', sources: owners.map((id) => source(id)) });
const courses = [{ id: 1, name: '经济学' }, { id: 2, name: '博弈论' }, { id: 3, name: '纳什均衡' }, { id: 4, name: '如何谈工资' }];

test('one visible node per course regardless of concept granularity', () => {
  const nodes = [topic('供需', [1]), topic('博弈论', [1, 2]), topic('纳什均衡', [2, 3]), topic('最佳回应', [2, 3]), topic('谈判', [4])];
  const graph = courseKnowledgeMap({ courses, nodes });
  assert.deepEqual(graph.nodes.map((n) => n.label), courses.map((c) => c.name));
  assert.deepEqual(graph.nodes.map((n) => n.topics.length), [2, 3, 2, 1]);
  assert.equal(graph.edges, undefined, '课程之间的连线早就不画了，不再计算');
});

test('a started course remains visible before concept extraction finishes', () => {
  const graph = courseKnowledgeMap({ courses: [courses[0]], nodes: [] });
  assert.equal(graph.nodes.length, 1);
  assert.deepEqual(graph.nodes[0].topics, []);
});

test('course details contain only their own lesson sources', () => {
  const graph = courseKnowledgeMap({ courses, nodes: [topic('纳什均衡', [2, 3])] });
  assert.deepEqual(graph.nodes[1].topics[0].sources.map((s) => s.course_id), [2]);
  assert.deepEqual(graph.nodes[2].topics[0].sources.map((s) => s.course_id), [3]);
});

test('no course is invented from stale concept sources or a shared category', () => {
  const graph = courseKnowledgeMap({ courses: [courses[0], courses[1]], nodes: [topic('独立主题', [1, 99]), topic('其他主题', [2])] });
  assert.deepEqual(graph.nodes.map((n) => n.courseId), [1, 2]);
});

test('duplicate evidence does not duplicate topics or sources', () => {
  const concept = topic('纳什均衡', [2, 2, 3]);
  const graph = courseKnowledgeMap({ courses, nodes: [concept, concept] });
  assert.equal(graph.nodes[1].topics.length, 1);
  assert.equal(graph.nodes[1].topics[0].sources.length, 1);
  assert.equal(graph.nodes[2].topics.length, 1);
});

test('different courses with the same title keep their identities', () => {
  const graph = courseKnowledgeMap({ courses: [{ id: 1, name: '统计学' }, { id: 2, name: '统计学' }], nodes: [] });
  assert.equal(graph.nodes.length, 2);
  assert.notEqual(graph.nodes[0].id, graph.nodes[1].id);
});

test('course nodes carry their read count and topic totals count each course separately', () => {
  const graph = courseKnowledgeMap({ courses: [{ id: 2, name: '博弈论', read_lessons: 3 }, { id: 1, name: '经济学' }], nodes: [] });
  assert.deepEqual(graph.nodes.map((n) => [n.courseId, n.readLessons]), [[2, 3], [1, undefined]]);
  assert.equal(courseTopicCount({ courses, nodes: [topic('博弈论', [1, 2]), topic('谈判', [4]), topic('外来', [99])] }), 3);
});
