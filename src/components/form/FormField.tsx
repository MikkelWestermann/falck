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
          {errors[0]?.toString()}
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
          {errors[0]?.toString()}
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
          {errors[0]?.toString()}
        </p>
      )}
    </div>
  );
};
