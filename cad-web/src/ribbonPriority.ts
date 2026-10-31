/**
 * How long a ribbon group stays expanded on a narrow desktop ribbon (RibbonGroup.priority): higher stays longer, and
 * groups fold into their dropdown lowest first (equal priorities right to left). Its own module so the workspaces'
 * command files can use it without a runtime import of '@/commands' (which imports them).
 */
export const KEEP = 100, HIGH = 80, MID = 60, LOW = 40;
