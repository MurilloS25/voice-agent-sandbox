import type { Metadata, Viewport } from "next";

import { AssistantHeader } from "@/components/AssistantHeader";
import { ChatPanel } from "@/components/ChatPanel";
import { DemoBanner } from "@/components/DemoBanner";
import { getBusinessOverview } from "@/lib/api/client";
import { draftFor, isCalendarDate, isServiceId } from "@/lib/assistant-link";
import { firstValue } from "@/lib/search-params";

export const metadata: Metadata = {
  title: "Ask the assistant | Quillwheel Cycle Works",
};

// Full-height app shell: let the page reach under the notch (the shell pads itself with the safe
// areas) and keep the layout from jumping when an on-screen keyboard opens.
export const viewport: Viewport = {
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
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
    <div className="relative flex h-dvh min-h-[26rem] flex-col overflow-hidden bg-[linear-gradient(180deg,rgb(143_211_206/0.28),var(--color-cream)_55%)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]">
      <AssistantHeader />
      <DemoBanner compact />
      <main className="min-h-0 flex-1 pt-2 sm:pt-3">
        <ChatPanel initialDraft={initialDraft} />
      </main>
    </div>
  );
}
