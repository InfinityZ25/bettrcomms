import { Moon, Sun, SunMoon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useTheme } from '@/components/theme-provider';
import { AnimatePresence, motion } from 'motion/react';
import { spring } from '@/lib/motion';

export function ModeToggle() {
  const { theme, setTheme } = useTheme();
  const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : SunMoon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon" className="relative border-border bg-background/60" aria-label="Toggle theme" />}
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={theme}
            initial={{ opacity: 0, rotate: -35, scale: 0.7 }}
            animate={{ opacity: 1, rotate: 0, scale: 1 }}
            exit={{ opacity: 0, rotate: 35, scale: 0.7 }}
            transition={spring}
            className="grid place-items-center"
          >
            <Icon className="size-[1.1rem]" />
          </motion.span>
        </AnimatePresence>
        <span className="sr-only">Toggle theme</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => setTheme('light')}><Sun aria-hidden="true" />Light</DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('dark')}><Moon aria-hidden="true" />Dark</DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('system')}><SunMoon aria-hidden="true" />System</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
