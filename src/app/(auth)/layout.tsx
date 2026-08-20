import { isAuthenticated } from "@/lib/auth-server";
import { AppShell } from "@/components/features/shell/app-shell";
import { redirect } from "next/navigation";
import { PropsWithChildren } from "react";

export default async function AuthLayout({ children }: PropsWithChildren) {
  if (!(await isAuthenticated())) {
    redirect("/sign-in");
  }
  return <AppShell>{children}</AppShell>;
}
