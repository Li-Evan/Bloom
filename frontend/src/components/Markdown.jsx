import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

const stripFences = (text) => {
  if (!text) return '';
  let t = text.trim();
  if (/^```(?:markdown|md)?\s*\n?/i.test(t)) {
    t = t.replace(/^```(?:markdown|md)?\s*\n?/i, '').replace(/\n?```\s*$/, '');
  }
  return t.trim();
};

const remarkPlugins = [remarkGfm, remarkMath];
// throwOnError:false → 个别不规范公式显示为红色文本而非整页崩溃（LLM 生成的 LaTeX 未必规范）
const rehypePlugins = [[rehypeKatex, { throwOnError: false, errorColor: '#dc2626', strict: 'ignore' }]];

export default function Markdown({ children }) {
  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}>
      {stripFences(children)}
    </ReactMarkdown>
  );
}
