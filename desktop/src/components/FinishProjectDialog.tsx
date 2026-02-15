import { useEffect, useMemo, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { normalizeBranchPrefix, stripBranchPrefix } from "@/lib/branching";
import { cn } from "@/lib/utils";
import { pullRequestSchema } from "@/schemas/forms";
import { falckService } from "@/services/falckService";
import { RepositoryInfo, gitService } from "@/services/gitService";
import {
  githubService,
  GithubCollaborator,
  GithubPullRequest,
} from "@/services/githubService";

interface FinishProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repoPath: string;
  repoInfo: RepositoryInfo;
  defaultBranch?: string | null;
  branchPrefix?: string | null;
}

const formatBranchTitle = (branch: string, prefix?: string | null): string => {
  const normalizedPrefix = normalizeBranchPrefix(prefix);
  const stripped = stripBranchPrefix(branch, normalizedPrefix);
  const cleaned = stripped.replace(/^[./_-]+/, "").replace(/[./_-]+$/, "");
  const words = cleaned.split(/[\/_-]+/).filter(Boolean);
  if (words.length === 0) {
    return "Project update";
  }
  return words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
};

const parseGithubRepoFullName = (remoteUrl: string): string | null => {
  const trimmed = remoteUrl.trim();
  if (!trimmed) return null;

  let host = "";
  let path = "";

  if (trimmed.startsWith("git@")) {
    const match = trimmed.match(/^git@([^:]+):(.+)$/);
    if (!match) return null;
    host = match[1];
    path = match[2];
  } else if (
    trimmed.startsWith("ssh://") ||
    trimmed.startsWith("https://") ||
    trimmed.startsWith("http://")
  ) {
    try {
      const url = new URL(trimmed);
      host = url.hostname;
      path = url.pathname.replace(/^\/+/, "");
    } catch {
      return null;
    }
  } else {
    return null;
  }

  if (host !== "github.com" && host !== "www.github.com") {
    return null;
  }

  const cleaned = path.replace(/\.git$/, "").replace(/\/+$/, "");
  const parts = cleaned.split("/").filter(Boolean);
  if (parts.length < 2) {
    return null;
  }
  const owner = parts[0];
  const repo = parts[1];
  if (!owner || !repo) {
    return null;
  }
  return `${owner}/${repo}`;
};

const resolveDefaultBaseBranch = (
  currentBranch: string,
  branches: string[],
  defaultBranch?: string | null,
): string => {
  if (defaultBranch && branches.includes(defaultBranch)) {
    return defaultBranch;
  }
  if (branches.includes("main")) {
    return "main";
  }
  if (branches.includes("master")) {
    return "master";
  }
  return branches.find((branch) => branch !== currentBranch) ?? currentBranch;
};

const MAX_REVIEWER_RENDER = 200;
const MAX_REVIEWERS = 15;

const getInitials = (name: string): string => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
};

const formatGithubError = (message: string): string => {
  const lower = message.toLowerCase();
  if (lower.includes("pull request")) {
    if (lower.includes("already")) {
      return "This project already has an update waiting on GitHub.";
    }
    return "We couldn't send this update to GitHub.";
  }
  if (
    lower.includes("authorization") ||
    lower.includes("authentication") ||
    lower.includes("token") ||
    lower.includes("auth")
  ) {
    return "We couldn't connect to GitHub. Reconnect your account and try again.";
  }
  if (lower.includes("reviewer")) {
    return "We couldn't add the people you picked.";
  }
  return message;
};

export function FinishProjectDialog({
  open,
  onOpenChange,
  repoPath,
  repoInfo,
  defaultBranch,
  branchPrefix,
}: FinishProjectDialogProps) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [draft, setDraft] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [remotes, setRemotes] = useState<string[]>([]);
  const [selectedRemote, setSelectedRemote] = useState<string | null>(null);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [repoFullName, setRepoFullName] = useState<string | null>(null);
  const [githubConnected, setGithubConnected] = useState<boolean | null>(null);
  const [reviewers, setReviewers] = useState<GithubCollaborator[]>([]);
  const [selectedReviewers, setSelectedReviewers] = useState<Set<string>>(
    new Set(),
  );
  const [reviewerQuery, setReviewerQuery] = useState("");
  const [reviewerLoading, setReviewerLoading] = useState(false);
  const [reviewerError, setReviewerError] = useState<string | null>(null);
  const [reviewerLimitNotice, setReviewerLimitNotice] = useState<string | null>(
    null,
  );
  const [reviewerNotice, setReviewerNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdPr, setCreatedPr] = useState<GithubPullRequest | null>(null);

  const currentBranch = repoInfo.head_branch;
  const branchNames = useMemo(
    () => repoInfo.branches.map((branch) => branch.name),
    [repoInfo.branches],
  );
  const selectedReviewerList = useMemo(
    () => Array.from(selectedReviewers),
    [selectedReviewers],
  );
  const reviewerLookup = useMemo(() => {
    const map = new Map<string, GithubCollaborator>();
    reviewers.forEach((reviewer) => {
      map.set(reviewer.login, reviewer);
    });
    return map;
  }, [reviewers]);
  const sortedReviewers = useMemo(
    () =>
      [...reviewers].sort((a, b) =>
        a.login.localeCompare(b.login, "en", { sensitivity: "base" }),
      ),
    [reviewers],
  );
  const filteredReviewers = useMemo(() => {
    const query = reviewerQuery.trim().toLowerCase();
    if (!query) {
      return sortedReviewers;
    }
    return sortedReviewers.filter((reviewer) => {
      const name = reviewer.name ?? "";
      return (
        reviewer.login.toLowerCase().includes(query) ||
        name.toLowerCase().includes(query)
      );
    });
  }, [sortedReviewers, reviewerQuery]);
  const renderReviewers = useMemo(
    () => filteredReviewers.slice(0, MAX_REVIEWER_RENDER),
    [filteredReviewers],
  );
  const selectedReviewerSummary = useMemo(() => {
    if (selectedReviewerList.length === 0) return "";
    const sorted = [...selectedReviewerList].sort((a, b) =>
      a.localeCompare(b, "en", { sensitivity: "base" }),
    );
    const names = sorted.map((login) => {
      const reviewer = reviewerLookup.get(login);
      return reviewer?.name?.trim() || reviewer?.login || login;
    });
    const display = names.slice(0, 2);
    if (names.length <= 2) {
      return display.join(", ");
    }
    return `${display.join(", ")} +${names.length - 2} more`;
  }, [selectedReviewerList, reviewerLookup]);

  const toggleReviewer = (login: string) => {
    setSelectedReviewers((prev) => {
      const next = new Set(prev);
      if (next.has(login)) {
        next.delete(login);
        setReviewerLimitNotice(null);
      } else {
        if (next.size >= MAX_REVIEWERS) {
          setReviewerLimitNotice(`Pick up to ${MAX_REVIEWERS} people.`);
          return next;
        }
        next.add(login);
        setReviewerLimitNotice(null);
      }
      return next;
    });
  };

  useEffect(() => {
    if (!open) {
      return;
    }
    setError(null);
    setCreatedPr(null);
    setDraft(false);
    setBody("");
    setShowAdvanced(false);
    setGithubConnected(null);
    setRemotes([]);
    setSelectedRemote(null);
    setRemoteError(null);
    setRepoFullName(null);
    setRemoteLoading(false);
    setReviewers([]);
    setSelectedReviewers(new Set());
    setReviewerQuery("");
    setReviewerLimitNotice(null);
    setReviewerLoading(false);
    setReviewerError(null);
    setReviewerNotice(null);
    setTitle(formatBranchTitle(currentBranch, branchPrefix));
    setBaseBranch(
      resolveDefaultBaseBranch(currentBranch, branchNames, defaultBranch),
    );

    void (async () => {
      try {
        const connected = await githubService.hasToken();
        setGithubConnected(connected);
      } catch {
        setGithubConnected(false);
      }
    })();

    void (async () => {
      setRemoteLoading(true);
      try {
        const remoteList = await gitService.getRemotes(repoPath);
        setRemotes(remoteList);
        if (remoteList.length === 0) {
          setSelectedRemote(null);
          return;
        }
        if (remoteList.includes("origin")) {
          setSelectedRemote("origin");
        } else {
          setSelectedRemote(remoteList[0]);
        }
      } catch (err) {
        console.error("Failed to load remotes:", err);
        setRemoteError("We couldn't check the GitHub connection.");
      } finally {
        setRemoteLoading(false);
      }
    })();
  }, [open, repoPath]);

  useEffect(() => {
    if (!open || !selectedRemote) {
      setRepoFullName(null);
      return;
    }
    setRemoteLoading(true);
    setRemoteError(null);
    setRepoFullName(null);
    void (async () => {
      try {
        const remoteUrl = await gitService.getRemoteUrl(
          repoPath,
          selectedRemote,
        );
        const parsed = parseGithubRepoFullName(remoteUrl);
        if (!parsed) {
          setRemoteError("This project isn't connected to GitHub yet.");
          return;
        }
        setRepoFullName(parsed);
      } catch (err) {
        console.error("Failed to resolve GitHub repo:", err);
        setRemoteError("We couldn't check the GitHub connection.");
      } finally {
        setRemoteLoading(false);
      }
    })();
  }, [open, repoPath, selectedRemote]);

  useEffect(() => {
    if (!open || !repoFullName || githubConnected !== true) {
      setReviewers([]);
      setReviewerLoading(false);
      setReviewerError(null);
      return;
    }
    setSelectedReviewers(new Set());
    setReviewerLoading(true);
    setReviewerError(null);
    void (async () => {
      try {
        const users = await githubService.listRepoCollaborators(repoFullName);
        setReviewers(users);
      } catch (err) {
        console.error("Failed to load reviewers:", err);
        setReviewerError("We couldn't load the review list from GitHub.");
      } finally {
        setReviewerLoading(false);
      }
    })();
  }, [open, repoFullName, githubConnected]);

  const blockedReason = useMemo(() => {
    if (repoInfo.is_dirty) {
      return "Save your changes before finishing this project.";
    }
    if (currentBranch === "detached") {
      return "Switch back to a project before closing it.";
    }
    if (defaultBranch && currentBranch === defaultBranch) {
      return "You're on the main project. Switch to the one you want to close.";
    }
    if (remoteLoading) {
      return "Checking your GitHub connection...";
    }
    if (!selectedRemote) {
      return "This project isn't connected to GitHub yet.";
    }
    if (remoteError) {
      return remoteError;
    }
    if (!repoFullName) {
      return "This project isn't connected to GitHub yet.";
    }
    if (githubConnected === null) {
      return "Checking GitHub connection...";
    }
    if (githubConnected === false) {
      return "Connect your GitHub account to continue.";
    }
    if (baseBranch && baseBranch === currentBranch) {
      return "Choose a different starting point in Advanced options.";
    }
    return null;
  }, [
    repoInfo.is_dirty,
    currentBranch,
    defaultBranch,
    selectedRemote,
    remoteLoading,
    remoteError,
    repoFullName,
    githubConnected,
    baseBranch,
  ]);

  const validation = pullRequestSchema.safeParse({
    title: title.trim(),
    base: baseBranch.trim(),
  });

  const canCreate =
    !loading &&
    !createdPr &&
    !blockedReason &&
    validation.success &&
    title.trim().length > 0 &&
    baseBranch.trim().length > 0;

  const handleCreatePullRequest = async () => {
    if (!validation.success) {
      setError(
        validation.error.issues[0]?.message ??
          "Check the details below.",
      );
      return;
    }
    if (blockedReason) {
      setError(blockedReason);
      return;
    }
    if (!selectedRemote || !repoFullName) {
      setError("Connect this project to GitHub to continue.");
      return;
    }

    setLoading(true);
    setError(null);
    setReviewerNotice(null);
    try {
      await gitService.push(repoPath, selectedRemote, currentBranch);
      const pr = await githubService.createPullRequest({
        repoFullName,
        title: validation.data.title,
        head: currentBranch,
        base: validation.data.base,
        body: body.trim() ? body.trim() : undefined,
        draft,
      });
      const reviewersToRequest = selectedReviewerList.slice(0, MAX_REVIEWERS);
      if (reviewersToRequest.length > 0) {
        try {
          const result = await githubService.requestReviewers({
            repoFullName,
            pullNumber: pr.number,
            reviewers: reviewersToRequest,
          });
          if (result.skipped.length > 0) {
            setReviewerNotice("Update sent. Some people could not be added.");
          }
        } catch (err) {
          console.error("Failed to add reviewers:", err);
          setReviewerNotice("Update sent. Some people could not be added.");
        }
      }
      setCreatedPr(pr);
    } catch (err) {
      setError(formatGithubError(String(err)));
    } finally {
      setLoading(false);
    }
  };

  const handleOpenPr = async () => {
    if (!createdPr) return;
    try {
      await falckService.openInBrowser(createdPr.html_url);
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-xl gap-0 overflow-y-auto border border-border/80 bg-card p-0 shadow-2xl sm:rounded-2xl">
        <DialogHeader className="space-y-1.5 border-b border-border/60 bg-card px-6 py-5">
          <DialogTitle className="text-xl font-semibold tracking-tight">
            Close this project
          </DialogTitle>
          <DialogDescription className="text-base text-muted-foreground">
            Ready to wrap things up? Share your update with the team.
          </DialogDescription>
          <p className="text-xs text-muted-foreground">
            Project{" "}
            <span className="font-mono text-foreground/80">
              {currentBranch}
            </span>
          </p>
        </DialogHeader>

        <div className="space-y-5 px-6 py-5">
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="finish-title">What did you finish?</Label>
              <Input
                id="finish-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="e.g. Updated the homepage copy"
                className="bg-background"
                disabled={loading || Boolean(createdPr)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="finish-body">Notes (optional)</Label>
              <Textarea
                id="finish-body"
                value={body}
                onChange={(event) => setBody(event.target.value)}
                placeholder="Add anything your team should know"
                className="min-h-[120px] resize-none bg-background"
                disabled={loading || Boolean(createdPr)}
              />
            </div>

            <div className="space-y-2">
              <Label>Who should take a look?</Label>
              {githubConnected === null || remoteLoading ? (
                <div className="rounded-lg border border-dashed border-border/60 bg-muted/30 px-4 py-4 text-sm text-muted-foreground">
                  Checking GitHub connection...
                </div>
              ) : githubConnected !== true || !repoFullName ? (
                <div className="rounded-lg border border-dashed border-border/60 bg-muted/30 px-4 py-4 text-sm text-muted-foreground">
                  Connect this project to GitHub to pick people.
                </div>
              ) : reviewerLoading ? (
                <div className="rounded-lg border border-dashed border-border/60 bg-muted/30 px-4 py-4 text-sm text-muted-foreground">
                  Loading people...
                </div>
              ) : reviewerError ? (
                <Alert variant="destructive">
                  <AlertDescription>{reviewerError}</AlertDescription>
                </Alert>
              ) : reviewers.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border/60 bg-muted/30 px-4 py-4 text-sm text-muted-foreground">
                  No teammates available to suggest yet.
                </div>
              ) : (
                <div className="space-y-3 rounded-lg border border-border/60 bg-muted/20 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Input
                      value={reviewerQuery}
                      onChange={(event) => setReviewerQuery(event.target.value)}
                      placeholder="Search by name or @handle"
                      className="h-8 text-sm bg-background"
                      disabled={loading || Boolean(createdPr)}
                    />
                    <div className="text-xs text-muted-foreground">
                      {filteredReviewers.length} of {reviewers.length}
                    </div>
                  </div>
                  {selectedReviewerList.length > 0 && (
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/50 bg-background px-3 py-2 text-xs text-muted-foreground">
                      <span>
                        Selected:{" "}
                        <span className="text-foreground">
                          {selectedReviewerSummary}
                        </span>
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-auto px-2 py-0 text-xs"
                        onClick={() => setSelectedReviewers(new Set())}
                        disabled={loading || Boolean(createdPr)}
                      >
                        Clear
                      </Button>
                    </div>
                  )}
                  {reviewerLimitNotice && (
                    <div className="text-xs text-muted-foreground">
                      {reviewerLimitNotice}
                    </div>
                  )}
                  <ScrollArea className="h-48">
                    <div className="space-y-2 pr-2">
                      {renderReviewers.length === 0 ? (
                        <div className="rounded-lg border border-dashed border-border/60 bg-muted/30 px-4 py-4 text-sm text-muted-foreground">
                          No matches. Try a different search.
                        </div>
                      ) : (
                        renderReviewers.map((reviewer) => {
                          const selected = selectedReviewers.has(
                            reviewer.login,
                          );
                          const displayName =
                            reviewer.name?.trim() || reviewer.login;
                          return (
                            <button
                              key={reviewer.login}
                              type="button"
                              onClick={() => toggleReviewer(reviewer.login)}
                              disabled={loading || Boolean(createdPr)}
                              className={cn(
                                "flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition",
                                selected
                                  ? "border-primary/40 bg-primary/10"
                                  : "border-border/60 bg-background hover:bg-muted/40",
                              )}
                              aria-pressed={selected}
                            >
                              <Avatar className="h-8 w-8">
                                <AvatarImage
                                  src={reviewer.avatar_url ?? undefined}
                                  alt={displayName}
                                />
                                <AvatarFallback>
                                  {getInitials(displayName)}
                                </AvatarFallback>
                              </Avatar>
                              <div className="flex-1">
                                <p className="text-sm font-semibold text-foreground">
                                  {displayName}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                  @{reviewer.login}
                                </p>
                              </div>
                              {selected && (
                                <Badge variant="secondary">Selected</Badge>
                              )}
                            </button>
                          );
                        })
                      )}
                      {filteredReviewers.length > MAX_REVIEWER_RENDER && (
                        <div className="rounded-lg border border-dashed border-border/60 bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
                          Showing the first {MAX_REVIEWER_RENDER}. Narrow the
                          search to see more.
                        </div>
                      )}
                    </div>
                  </ScrollArea>
                </div>
              )}
            </div>

            <Collapsible
              open={showAdvanced}
              onOpenChange={setShowAdvanced}
              className="rounded-lg border border-dashed border-border/60 bg-muted/20 px-4 py-3"
            >
              <CollapsibleTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-auto px-2 py-1.5 text-muted-foreground hover:text-foreground"
                >
                  {showAdvanced ? "Hide options" : "More options"}
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="mt-4 space-y-4">
                  <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_200px]">
                    <div className="space-y-2">
                      <Label>Starting point</Label>
                      <Select
                        value={baseBranch}
                        onValueChange={setBaseBranch}
                        disabled={loading || Boolean(createdPr)}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Select starting point" />
                        </SelectTrigger>
                        <SelectContent>
                          {branchNames.map((branch) => (
                            <SelectItem key={branch} value={branch}>
                              {branch}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-2">
                      <Label>GitHub destination</Label>
                      <Select
                        value={selectedRemote ?? ""}
                        onValueChange={setSelectedRemote}
                        disabled={
                          loading || Boolean(createdPr) || remotes.length === 0
                        }
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Select destination" />
                        </SelectTrigger>
                        <SelectContent>
                          {remotes.map((remote) => (
                            <SelectItem key={remote} value={remote}>
                              {remote}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {repoFullName && (
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span className="uppercase tracking-[0.2em]">GitHub</span>
                      <Badge variant="secondary" className="font-mono">
                        {repoFullName}
                      </Badge>
                    </div>
                  )}

                  <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border/60 bg-background px-4 py-3">
                    <div>
                      <p className="text-sm font-semibold">Not quite ready</p>
                      <p className="text-xs text-muted-foreground">
                        Keep this marked as in progress.
                      </p>
                    </div>
                    <Switch
                      checked={draft}
                      onCheckedChange={setDraft}
                      disabled={loading || Boolean(createdPr)}
                    />
                  </div>
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>
        </div>

        {blockedReason && !createdPr && (
          <Alert variant="destructive" className="mx-6 mt-5 w-auto">
            <AlertDescription>{blockedReason}</AlertDescription>
          </Alert>
        )}

        {error && (
          <Alert variant="destructive" className="mx-6 mt-4 w-auto">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {reviewerNotice && (
          <Alert className="mx-6 mt-4 w-auto">
            <AlertDescription>{reviewerNotice}</AlertDescription>
          </Alert>
        )}

        {createdPr && (
          <Alert className="mx-6 mt-4 w-auto">
            <AlertDescription>
              All set. Your update is ready.
            </AlertDescription>
          </Alert>
        )}

        <DialogFooter className="border-t border-border/60 bg-card px-6 pb-6 pt-4">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={loading}
          >
            Close
          </Button>
          {createdPr ? (
            <Button onClick={handleOpenPr}>Open on GitHub</Button>
          ) : (
            <Button onClick={handleCreatePullRequest} disabled={!canCreate}>
              {loading ? "Sending..." : "Send for review"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
