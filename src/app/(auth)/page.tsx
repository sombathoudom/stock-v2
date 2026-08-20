import { redirect } from "next/navigation";

// The app root is the dashboard. Redirecting keeps the URL and the active
// nav state consistent — every nav item owns its own route.
export default function Home() {
  redirect("/dashboard");
}
