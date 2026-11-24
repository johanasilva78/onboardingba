import { Onboarding } from "@/components/Onboarding";

export const dynamic = "force-dynamic";

export default function Page() {
  return <Onboarding connected={Boolean(process.env.ONBOARDING_FUNCTION_NAME)} />;
}
