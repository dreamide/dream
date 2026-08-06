export const toggleExpandedPathForProject = (
  current: Record<string, string[]>,
  projectId: string,
  filePath: string,
): Record<string, string[]> => {
  const currentPaths = current[projectId] ?? [];
  const nextPaths = currentPaths.includes(filePath)
    ? currentPaths.filter((path) => path !== filePath)
    : [...currentPaths, filePath];

  return {
    ...current,
    [projectId]: nextPaths,
  };
};
