import { useEffect, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { gitService } from "@/services/gitService";

interface RemoteOperationsProps {
  repoPath: string;
  currentBranch: string;
  pushDisabled?: boolean;
}

export function RemoteOperations({
  repoPath,
  currentBranch,
  pushDisabled = false,
}: RemoteOperationsProps) {
  const [remotes, setRemotes] = useState<string[]>([]);
  const [selectedRemote, setSelectedRemote] = useState("origin");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void loadRemotes();
  }, [repoPath]);

  const loadRemotes = async () => {
    try {
      const remoteList = await gitService.getRemotes(repoPath);
      setRemotes(remoteList);
      if (remoteList.length > 0) {
        setSelectedRemote(remoteList[0]);
      }
    } catch (err) {
      console.error("Failed to load remotes:", err);
    }
  };

  const handlePush = async () => {
    if (pushDisabled) {
      return;
    }
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      await gitService.push(repoPath, selectedRemote, currentBranch);
      setMessage(`Shared to ${selectedRemote}/${currentBranch}`);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const handlePull = async () => {
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      await gitService.pull(repoPath, selectedRemote, currentBranch);
      setMessage(`Updated from ${selectedRemote}/${currentBranch}`);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sync</CardTitle>
        <CardDescription>Share your work and get updates.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {remotes.length === 0 ? (
          <div className="rounded-lg border-2 border-dashed border-border/70 px-4 py-6 text-center text-sm text-muted-foreground">
            No sync destination configured.
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex-1">
                <Select value={selectedRemote} onValueChange={setSelectedRemote}>
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
              <Badge variant="secondary" className="w-fit">
                {currentBranch}
              </Badge>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={handlePull} disabled={loading}>
                {loading ? "Checking…" : "Get updates"}
              </Button>
              <Button onClick={handlePush} disabled={loading || pushDisabled}>
                {loading ? "Sharing…" : "Share changes"}
              </Button>
            </div>
          </>
        )}

        {pushDisabled && remotes.length > 0 && (
          <Alert variant="destructive">
            <AlertDescription>
              Sharing is disabled on the default project.
            </AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {message && (
          <Alert>
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
