import type { ComponentProps } from 'react';
import { PersonalInboxButton } from '@/features/personal/PersonalInbox';

/**
 * The personal inbox's button, dressed as a rail button.
 *
 * The button and everything it opens belong to the inbox; this only gives it
 * the rail's shape, size and colours. The wrapper draws no box of its own
 * (`display: contents`), so in the rail and in the phone tab bar the button is
 * laid out exactly where it always was, and the phone keeps its own sizing.
 */
export function ActivityReminderInbox(
  props: ComponentProps<typeof PersonalInboxButton>,
) {
  return (
    <span className="contents dark:[&>button:hover]:bg-sidebar-accent [&>button]:text-muted-foreground [&>button]:transition-[color,background-color,border-radius,box-shadow,transform] [&>button]:duration-200 [&>button]:ease-out [&>button:hover]:bg-sidebar-accent [&>button:hover]:text-foreground [&>button>span]:h-[18px] [&>button>span]:min-w-[18px] [&>button>span]:text-[0.6875rem] [&>button>span]:font-semibold [&>button>span]:tabular-nums [&>button>span]:ring-2 [&>button>span]:ring-[color:var(--avatar-ring,var(--background))] min-[821px]:[&>button]:size-11 min-[821px]:[&>button]:rounded-2xl min-[821px]:[&>button:hover]:rounded-xl min-[821px]:[&>button_svg]:size-5!">
      <PersonalInboxButton {...props} />
    </span>
  );
}
