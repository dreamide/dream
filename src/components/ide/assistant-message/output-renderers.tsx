import { CodeBlock } from "@/components/ai-elements/code-block";
import {
  FileTreeFile,
  FileTreeFolder,
} from "@/components/ai-elements/file-tree";
import { stringifyPart } from "../ide-state";

export const JsonBlock = ({ value }: { value: unknown }) => (
  <CodeBlock code={stringifyPart(value)} language="json" />
);

export interface FileTreeNode {
  name: string;
  path: string;
  children: Map<string, FileTreeNode>;
  isFile: boolean;
}

export const buildFileTree = (
  paths: string[],
): { root: FileTreeNode; defaultExpanded: Set<string> } => {
  const root: FileTreeNode = {
    name: "",
    path: "",
    children: new Map(),
    isFile: false,
  };

  for (const filePath of paths) {
    const parts = filePath.split(/[\\/]/);
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const currentPath = parts.slice(0, i + 1).join("/");
      const isLast = i === parts.length - 1;

      if (!current.children.has(part)) {
        current.children.set(part, {
          name: part,
          path: currentPath,
          children: new Map(),
          isFile: isLast,
        });
      }

      const nextNode = current.children.get(part);
      if (!nextNode) {
        continue;
      }
      current = nextNode;
    }
  }

  const defaultExpanded = new Set<string>();
  for (const child of root.children.values()) {
    if (!child.isFile) {
      defaultExpanded.add(child.path);
    }
  }

  return { root, defaultExpanded };
};

export const FileTreeNodeView = ({ node }: { node: FileTreeNode }) => {
  const sortedChildren = [...node.children.values()].sort((a, b) => {
    if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  if (node.isFile) {
    return <FileTreeFile name={node.name} path={node.path} />;
  }

  return (
    <FileTreeFolder name={node.name} path={node.path}>
      {sortedChildren.map((child) => (
        <FileTreeNodeView key={child.path} node={child} />
      ))}
    </FileTreeFolder>
  );
};
