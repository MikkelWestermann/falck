import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { CommitInfo, gitService } from "@/services/gitService";

interface CommitHistoryProps {
  repoPath: string;
}

export function CommitHistory({ repoPath }: CommitHistoryProps) {
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void loadCommits();
  }, [repoPath]);

  const loadCommits = async () => {
    setLoading(true);
    try {
      const history = await gitService.getCommitHistory(repoPath, 50);
      setCommits(history);
    } catch (err) {
      console.error("Failed to load commits:", err);
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (timestamp: number) =>
    new Date(timestamp * 1000).toLocaleString();

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle>Commit history</CardTitle>
          <CardDescription>Latest activity from the current branch.</CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={loadCommits}>
          Refresh
        </Button>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="rounded-2xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
            Loading commits…
          </div>
        ) : commits.length === 0 ? (
          <div className="rounded-2xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
            No commits found.
          </div>
        ) : (
          <div className="space-y-3">
            {commits.map((commit) => (
              <div
                key={commit.id}
                className="flex flex-col gap-2 rounded-2xl border border-border/60 bg-card/80 p-4 sm:flex-row sm:items-start"
              >
                <Badge variant="muted" className="w-fit rounded-full font-mono">
                  {commit.id.substring(0, 7)}
                </Badge>
                <div>
                  <div className="text-sm font-semibold text-foreground">
                    {commit.message}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {commit.author} · {formatDate(commit.timestamp)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
