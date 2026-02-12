import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ArrowLeft, Globe, Sparkles } from "lucide-react";

export const Route = createFileRoute("/create/")({
  component: CreateProjectIndexRoute,
});

function CreateProjectIndexRoute() {
  const navigate = Route.useNavigate();

  return (
    <div className="relative min-h-screen overflow-hidden bg-page-background text-foreground">
      <div className="relative mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-10 lg:py-14">
        <header
          className="flex flex-col gap-4 animate-in fade-in slide-in-from-bottom-4"
          style={{ animationDuration: "600ms" }}
        >
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate({ to: "/repo" })}
            className="w-fit"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to repositories
          </Button>
          <div className="space-y-2">
            <h1 className="text-3xl font-semibold text-foreground">
              Create a new project
            </h1>
            <p className="text-sm text-muted-foreground">
              Start from a curated template and ship faster.
            </p>
          </div>
        </header>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card
            className="border-border/60 bg-background/85 shadow-[0_20px_60px_rgba(15,23,42,0.08)] backdrop-blur animate-in fade-in slide-in-from-bottom-4"
            style={{ animationDuration: "750ms" }}
          >
            <CardHeader className="space-y-2">
              <CardTitle className="text-xl">Marketing site</CardTitle>
              <CardDescription>
                Astro + Falck template with clean marketing pages.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Globe className="h-4 w-4" />
                Astro starter - MikkelWestermann/falck-astro
              </div>
              <Button
                onClick={() => navigate({ to: "/create/astro" })}
                className="w-full normal-case tracking-normal"
              >
                Choose Astro
              </Button>
            </CardContent>
          </Card>

          <Card
            className="border-border/60 bg-background/60 shadow-[0_16px_40px_rgba(15,23,42,0.06)] backdrop-blur opacity-70 animate-in fade-in slide-in-from-bottom-4"
            style={{ animationDuration: "850ms" }}
          >
            <CardHeader className="space-y-2">
              <CardTitle className="text-xl">More coming soon</CardTitle>
              <CardDescription>
                Productized stacks for apps, docs, and internal tools.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex h-full flex-col items-start justify-between gap-4">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Sparkles className="h-4 w-4" />
                Stay tuned for more templates.
              </div>
              <Button
                variant="outline"
                disabled
                className="w-full normal-case tracking-normal"
              >
                Not ready yet
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
