import type { Metadata } from "next";

import { AssistantHeader } from "@/components/AssistantHeader";
import { ChatPanel } from "@/components/ChatPanel";
import { DemoBanner } from "@/components/DemoBanner";
import { getBusinessOverview } from "@/lib/api/client";
import { draftFor, isCalendarDate, isServiceId } from "@/lib/assistant-link";
import { firstValue } from "@/lib/search-params";

export const metadata: Metadata = {
  title: "Ask the assistant | Quillwheel Cycle Works",
};

/**
 * The visitor-editable draft for `?service=&date=`. Both values are checked here; the service
 * must also be one the schedule service lists, so its name (not the URL text) is what is shown.
 * Without a usable context, or when the schedule service cannot answer, there is no draft.
 * Nothing is sent: the draft only fills the message box.
 */
async function draftFromLink(
  serviceParam: string | undefined,
  dateParam: string | undefined,
): Promise<string> {
  const date = isCalendarDate(dateParam) ? dateParam : undefined;
  let serviceName: string | undefined;
  if (isServiceId(serviceParam)) {
    const overview = await getBusinessOverview();
    if (overview.kind === "ok") {
      serviceName = overview.data.services.find(
        (service) => service.id === serviceParam,
      )?.name;
    }
  }
  return draftFor({ serviceName, date });
}

export default async function AssistantPage(props: PageProps<"/assistant">) {
  const searchParams = await props.searchParams;
  const initialDraft = await draftFromLink(
    firstValue(searchParams.service),
    firstValue(searchParams.date),
  );

  return (
    <>
      <AssistantHeader />
      <main className="mx-auto w-full max-w-6xl space-y-6 px-4 py-6 sm:px-8 sm:py-8">
        <DemoBanner />
        <ChatPanel initialDraft={initialDraft} />
      </main>
    </>
  );
}
