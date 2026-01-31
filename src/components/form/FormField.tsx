import React from "react";
import { FieldApi } from "@tanstack/react-form";

import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

const formatError = (error: unknown, depth = 0): string => {
  if (depth > 2) {
    return "Invalid input.";
  }
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (Array.isArray(error)) {
    for (const item of error) {
      const message = formatError(item, depth + 1);
      if (message && message !== "Invalid input.") {
        return message;
      }
    }
  }
  if (error instanceof Map) {
    for (const value of error.values()) {
      const message = formatError(value, depth + 1);
      if (message && message !== "Invalid input.") {
        return message;
      }
    }
  }
  if (error && typeof error === "object") {
    const candidate = error as {
      message?: unknown;
      issues?: unknown;
      errors?: unknown;
      cause?: unknown;
    };
    if (typeof candidate.message === "string" && candidate.message.length > 0) {
      return candidate.message;
    }
    if (Array.isArray(candidate.issues) && candidate.issues.length > 0) {
      const issue = candidate.issues[0] as { message?: unknown };
      if (typeof issue?.message === "string") {
        return issue.message;
      }
    }
    if (Array.isArray(candidate.errors) && candidate.errors.length > 0) {
      const nested = formatError(candidate.errors[0], depth + 1);
      if (nested) {
        return nested;
      }
    }
    if (candidate.cause) {
      const nested = formatError(candidate.cause, depth + 1);
      if (nested) {
        return nested;
      }
    }
    const ownKeys = Object.getOwnPropertyNames(error);
    if (ownKeys.length > 0) {
      const snapshot = Object.fromEntries(
        ownKeys.map((key) => [key, (error as Record<string, unknown>)[key]]),
      );
      try {
        return JSON.stringify(snapshot);
      } catch {
        return String(error);
      }
    }
  }
  const fallback = String(error);
  return fallback === "[object Object]" ? "Invalid input." : fallback;
};

interface FormFieldProps {
  field: FieldApi<any, any, any, any>;
  label?: string;
  placeholder?: string;
  type?: "text" | "email" | "password" | "number";
  helpText?: string;
  required?: boolean;
}

export const FormField: React.FC<FormFieldProps> = ({
  field,
  label,
  placeholder,
  type = "text",
  helpText,
  required,
}) => {
  const errors = field.state.meta.errors ?? [];
  const isInvalid = errors.length > 0;

  return (
    <div className="flex flex-col space-y-2">
      {label && (
        <Label
          htmlFor={field.name}
          className={cn(
            required && "after:ml-0.5 after:text-destructive after:content-['*']",
          )}
        >
          {label}
        </Label>
      )}
      <Input
        id={field.name}
        type={type}
        placeholder={placeholder}
        value={field.state.value ?? ""}
        onChange={(e) => field.handleChange(e.target.value)}
        onBlur={field.handleBlur}
        aria-invalid={isInvalid}
        className={cn(isInvalid && "border-destructive focus-visible:ring-destructive")}
      />
      {errors.length > 0 && (
        <p className="text-sm font-medium text-destructive">
          {formatError(errors[0])}
        </p>
      )}
      {helpText && !isInvalid && (
        <p className="text-xs text-muted-foreground">{helpText}</p>
      )}
    </div>
  );
};

export const FormTextarea: React.FC<FormFieldProps> = ({
  field,
  label,
  placeholder,
  helpText,
  required,
}) => {
  const errors = field.state.meta.errors ?? [];
  const isInvalid = errors.length > 0;

  return (
    <div className="flex flex-col space-y-2">
      {label && (
        <Label
          htmlFor={field.name}
          className={cn(
            required && "after:ml-0.5 after:text-destructive after:content-['*']",
          )}
        >
          {label}
        </Label>
      )}
      <Textarea
        id={field.name}
        placeholder={placeholder}
        value={field.state.value ?? ""}
        onChange={(e) => field.handleChange(e.target.value)}
        onBlur={field.handleBlur}
        aria-invalid={isInvalid}
        className={cn(isInvalid && "border-destructive focus-visible:ring-destructive")}
      />
      {errors.length > 0 && (
        <p className="text-sm font-medium text-destructive">
          {formatError(errors[0])}
        </p>
      )}
      {helpText && !isInvalid && (
        <p className="text-xs text-muted-foreground">{helpText}</p>
      )}
    </div>
  );
};

export const FormSelect: React.FC<
  FormFieldProps & { options: { label: string; value: string }[] }
> = ({ field, label, options, required }) => {
  const errors = field.state.meta.errors ?? [];
  const isInvalid = errors.length > 0;

  return (
    <div className="flex flex-col space-y-2">
      {label && (
        <Label
          className={cn(
            required && "after:ml-0.5 after:text-destructive after:content-['*']",
          )}
        >
          {label}
        </Label>
      )}
      <Select value={field.state.value ?? ""} onValueChange={field.handleChange}>
        <SelectTrigger
          aria-invalid={isInvalid}
          className={cn(isInvalid && "border-destructive")}
        >
          <SelectValue placeholder="Select an option" />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {errors.length > 0 && (
        <p className="text-sm font-medium text-destructive">
          {formatError(errors[0])}
        </p>
      )}
    </div>
  );
};
