"use client";

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const markdownComponents: Components = {
  a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>,
  img: () => null,
};

const markdownPlugins = [remarkGfm];

export default function AssistantAnswer({ children }: { children: string }) {
  return (
    <div className="assistant-markdown">
      <ReactMarkdown
        remarkPlugins={markdownPlugins}
        skipHtml
        components={markdownComponents}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
