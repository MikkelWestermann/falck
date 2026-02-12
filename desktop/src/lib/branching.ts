export const branchNamePattern = /^[a-zA-Z0-9._/-]+$/;

export const normalizeBranchPrefix = (
  prefix?: string | null,
): string | null => {
  if (!prefix) {
    return null;
  }
  const trimmed = prefix.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const stripBranchPrefix = (
  name: string,
  prefix?: string | null,
): string => {
  if (!prefix) {
    return name;
  }
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
};

export const applyBranchPrefix = (
  name: string,
  prefix?: string | null,
): string => {
  if (!prefix) {
    return name;
  }
  return name.startsWith(prefix) ? name : `${prefix}${name}`;
};

export const isValidBranchName = (name: string): boolean =>
  branchNamePattern.test(name);
