import { z } from "zod";

export const createZodValidator = <T extends z.ZodSchema>(schema: T) => {
  return async (value: unknown) => {
    try {
      await schema.parseAsync(value);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return err.errors[0]?.message || "Invalid input";
      }
    }
  };
};

export const createFieldValidator = <T extends z.ZodSchema>(schema: T) => {
  return async (value: unknown) => {
    try {
      await schema.parseAsync(value);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return err.errors[0]?.message;
      }
    }
  };
};
