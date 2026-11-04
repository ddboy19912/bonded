import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Joins class names, letting a later Tailwind class win over an earlier one. shadcn/ui's helper. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
