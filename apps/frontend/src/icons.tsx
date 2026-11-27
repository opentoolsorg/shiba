/**
 * lucide-react compatibility layer backed by Hugeicons free set.
 *
 * The dashboard's imports (`from "lucide-react"`) resolve here via the Vite
 * alias in vite.config.ts. Each export keeps the lucide name so call sites are
 * unchanged while the rendered glyphs come from @hugeicons/core-free-icons.
 */

import {
  Activity01Icon,
  AiSparklesIcon,
  Alert02Icon,
  AlertCircleIcon,
  TextUnderlineIcon,
  TextAlignCenterIcon,
  HighlighterIcon,
  CheckListIcon,
  AlignRightIcon,
  AlignLeftIcon,
  AppWindowIcon,
  ArchiveIcon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowUp01Icon,
  ArrowUpRight01Icon,
  AtSignIcon,
  BanIcon,
  BarChartIcon,
  BellIcon,
  BlocksIcon,
  BookBookmarkIcon,
  BookOpen01Icon,
  BoxIcon,
  Brain01Icon,
  BubbleChatIcon,
  Building02Icon,
  Calendar03Icon,
  Cancel01Icon,
  ChartNoAxesColumnIcon,
  CheckmarkCircle02Icon,
  CheckmarkSquare01Icon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleDotIcon,
  CircleIcon,
  Clock01Icon,
  Clock03Icon,
  CloudIcon,
  CommandIcon,
  ComputerTerminal01Icon,
  ContainerIcon,
  Copy01Icon,
  CornerLeftUpIcon,
  CpuIcon,
  DashboardSpeed01Icon,
  DashboardSquare01Icon,
  DashedLineCircleIcon,
  Database01Icon,
  Delete02Icon,
  Download01Icon,
  EraserIcon,
  ExternalLinkIcon,
  FileArchiveIcon,
  FileEditIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FlaskConicalIcon,
  FolderGit2Icon,
  FolderPlusIcon,
  GitBranchIcon,
  GitCompareArrowsIcon,
  GitPullRequestIcon,
  Globe02Icon,
  HashIcon,
  Heading01Icon,
  Heading02Icon,
  HelpCircleIcon,
  HistoryIcon,
  Home01Icon,
  InboxIcon,
  KanbanIcon,
  Key01Icon,
  KeyRoundIcon,
  LaptopIcon,
  LayoutGridIcon,
  LeftToRightListDashIcon,
  LeftToRightListNumberIcon,
  LicensePinIcon,
  Link02Icon,
  ListChecksIcon,
  LoaderCircleIcon,
  Loading03Icon,
  LockIcon,
  LockKeyholeIcon,
  Mail01Icon,
  Maximize02Icon,
  MessageCircleIcon,
  MessageSquareIcon,
  Mic01Icon,
  MonitorIcon,
  Moon02Icon,
  MoreHorizontalIcon,
  NetworkIcon,
  OctagonAlertIcon,
  PaintBoardIcon,
  PanelLeftIcon,
  PanelRightIcon,
  PanelsTopLeftIcon,
  PaperclipIcon,
  PencilIcon,
  PlugIcon,
  PlusSignIcon,
  Presentation01Icon,
  RadioIcon,
  RefreshCwIcon,
  RobotIcon,
  RotateCcwIcon,
  Search01Icon,
  SentIcon,
  ServerIcon,
  Settings02Icon,
  Shield01Icon,
  ShieldCheckIcon,
  ShuffleIcon,
  SlidersHorizontalIcon,
  SourceCodeIcon,
  Square01Icon,
  SquareArrowOutUpRightIcon,
  SquareChartGanttIcon,
  StickyNote01Icon,
  Sun03Icon,
  TextBoldIcon,
  TextFontIcon,
  TextItalicIcon,
  TextStrikethroughIcon,
  Tick02Icon,
  TickDouble02Icon,
  ToggleLeftIcon,
  ToggleRightIcon,
  Upload01Icon,
  UserAdd01Icon,
  UserCheck01Icon,
  UserIcon,
  UserMultiple02Icon,
  ViewIcon,
  WebhookIcon,
  WorkflowIcon,
  Wrench01Icon,
  ZapIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  type ForwardRefExoticComponent,
  forwardRef,
  type RefAttributes,
  type SVGProps,
} from "react";

export type LucideProps = SVGProps<SVGSVGElement> & {
  /** px size of the square glyph; lucide default is 24. */
  size?: string | number;
  strokeWidth?: number;
  absoluteStrokeWidth?: boolean;
};
export type LucideIcon = ForwardRefExoticComponent<LucideProps & RefAttributes<SVGSVGElement>>;

function defineIcon(name: string, icon: IconSvgElement): LucideIcon {
  const Component = forwardRef<SVGSVGElement, LucideProps>(({ size = 24, ...props }, ref) => (
    <HugeiconsIcon ref={ref} icon={icon} size={size} {...props} />
  ));
  Component.displayName = name;
  return Component;
}

export const AlignCenter = defineIcon("AlignCenter", TextAlignCenterIcon);
export const AlignLeft = defineIcon("AlignLeft", AlignLeftIcon);
export const AlignRight = defineIcon("AlignRight", AlignRightIcon);
export const AppWindow = defineIcon("AppWindow", AppWindowIcon);
export const ArrowUp = defineIcon("ArrowUp", ArrowUp01Icon);
export const ArrowUpRight = defineIcon("ArrowUpRight", ArrowUpRight01Icon);
export const AtSign = defineIcon("AtSign", AtSignIcon);
export const Ban = defineIcon("Ban", BanIcon);
export const Bell = defineIcon("Bell", BellIcon);
export const Bold = defineIcon("Bold", TextBoldIcon);
export const BookOpen = defineIcon("BookOpen", BookOpen01Icon);
export const Brain = defineIcon("Brain", Brain01Icon);
export const Building2 = defineIcon("Building2", Building02Icon);
export const Check = defineIcon("Check", Tick02Icon);
export const CheckCheck = defineIcon("CheckCheck", TickDouble02Icon);
export const CheckSquare = defineIcon("CheckSquare", CheckmarkSquare01Icon);
export const ChevronDown = defineIcon("ChevronDown", ChevronDownIcon);
export const ChevronRight = defineIcon("ChevronRight", ChevronRightIcon);
export const CircleDashed = defineIcon("CircleDashed", DashedLineCircleIcon);
export const CircleDot = defineIcon("CircleDot", CircleDotIcon);
export const Clock = defineIcon("Clock", Clock01Icon);
export const Code = defineIcon("Code", SourceCodeIcon);
export const Copy = defineIcon("Copy", Copy01Icon);
export const Database = defineIcon("Database", Database01Icon);
export const Download = defineIcon("Download", Download01Icon);
export const ExternalLink = defineIcon("ExternalLink", ExternalLinkIcon);
export const Eye = defineIcon("Eye", ViewIcon);
export const FileArchive = defineIcon("FileArchive", FileArchiveIcon);
export const FileSpreadsheet = defineIcon("FileSpreadsheet", FileSpreadsheetIcon);
export const FileText = defineIcon("FileText", FileTextIcon);
export const FlaskConical = defineIcon("FlaskConical", FlaskConicalIcon);
export const FolderGit2 = defineIcon("FolderGit2", FolderGit2Icon);
export const FolderPlus = defineIcon("FolderPlus", FolderPlusIcon);
export const GitCompareArrows = defineIcon("GitCompareArrows", GitCompareArrowsIcon);
export const Globe2 = defineIcon("Globe2", Globe02Icon);
export const Hash = defineIcon("Hash", HashIcon);
export const Heading1 = defineIcon("Heading1", Heading01Icon);
export const Heading2 = defineIcon("Heading2", Heading02Icon);
export const Highlighter = defineIcon("Highlighter", HighlighterIcon);
export const History = defineIcon("History", HistoryIcon);
export const Italic = defineIcon("Italic", TextItalicIcon);
export const KeyRound = defineIcon("KeyRound", KeyRoundIcon);
export const Laptop = defineIcon("Laptop", LaptopIcon);
export const LayoutGrid = defineIcon("LayoutGrid", LayoutGridIcon);
export const Link2 = defineIcon("Link2", Link02Icon);
export const List = defineIcon("List", LeftToRightListDashIcon);
export const ListChecks = defineIcon("ListChecks", ListChecksIcon);
export const ListTodo = defineIcon("ListTodo", CheckListIcon);
export const ListOrdered = defineIcon("ListOrdered", LeftToRightListNumberIcon);
export const Loader2 = defineIcon("Loader2", Loading03Icon);
export const LoaderCircle = defineIcon("LoaderCircle", LoaderCircleIcon);
export const Lock = defineIcon("Lock", LockIcon);
export const LockKeyhole = defineIcon("LockKeyhole", LockKeyholeIcon);
export const Maximize2 = defineIcon("Maximize2", Maximize02Icon);
export const MessageCircle = defineIcon("MessageCircle", MessageCircleIcon);
export const MessageSquare = defineIcon("MessageSquare", MessageSquareIcon);
export const Mic = defineIcon("Mic", Mic01Icon);
export const Monitor = defineIcon("Monitor", MonitorIcon);
export const MoreHorizontal = defineIcon("MoreHorizontal", MoreHorizontalIcon);
export const Network = defineIcon("Network", NetworkIcon);
export const PanelLeft = defineIcon("PanelLeft", PanelLeftIcon);
export const PanelRight = defineIcon("PanelRight", PanelRightIcon);
export const PanelsTopLeft = defineIcon("PanelsTopLeft", PanelsTopLeftIcon);
export const Paperclip = defineIcon("Paperclip", PaperclipIcon);
export const Pin = defineIcon("Pin", LicensePinIcon);
export const Plug = defineIcon("Plug", PlugIcon);
export const Plus = defineIcon("Plus", PlusSignIcon);
export const Presentation = defineIcon("Presentation", Presentation01Icon);
export const Radio = defineIcon("Radio", RadioIcon);
export const RefreshCw = defineIcon("RefreshCw", RefreshCwIcon);
export const Search = defineIcon("Search", Search01Icon);
export const Server = defineIcon("Server", ServerIcon);
export const Shield = defineIcon("Shield", Shield01Icon);
export const ShieldCheck = defineIcon("ShieldCheck", ShieldCheckIcon);
export const Shuffle = defineIcon("Shuffle", ShuffleIcon);
export const Sliders = defineIcon("Sliders", SlidersHorizontalIcon);
export const Sparkles = defineIcon("Sparkles", AiSparklesIcon);
export const Square = defineIcon("Square", Square01Icon);
export const SquareArrowOutUpRight = defineIcon("SquareArrowOutUpRight", SquareArrowOutUpRightIcon);
export const StickyNote = defineIcon("StickyNote", StickyNote01Icon);
export const Strikethrough = defineIcon("Strikethrough", TextStrikethroughIcon);
export const Terminal = defineIcon("Terminal", ComputerTerminal01Icon);
export const Type = defineIcon("Type", TextFontIcon);
export const Underline = defineIcon("Underline", TextUnderlineIcon);
export const Upload = defineIcon("Upload", Upload01Icon);
export const UserPlus = defineIcon("UserPlus", UserAdd01Icon);
export const Users = defineIcon("Users", UserMultiple02Icon);
export const Workflow = defineIcon("Workflow", WorkflowIcon);
export const Wrench = defineIcon("Wrench", Wrench01Icon);
export const X = defineIcon("X", Cancel01Icon);
export const Zap = defineIcon("Zap", ZapIcon);

export const Activity = defineIcon("Activity", Activity01Icon);
export const AlertCircle = defineIcon("AlertCircle", AlertCircleIcon);
export const AlertTriangle = defineIcon("AlertTriangle", Alert02Icon);
export const TriangleAlert = AlertTriangle;
export const Archive = defineIcon("Archive", ArchiveIcon);
export const ArrowLeft = defineIcon("ArrowLeft", ArrowLeft01Icon);
export const ArrowRight = defineIcon("ArrowRight", ArrowRight01Icon);
export const BarChart3 = defineIcon("BarChart3", BarChartIcon);
export const Blocks = defineIcon("Blocks", BlocksIcon);
export const BookMarked = defineIcon("BookMarked", BookBookmarkIcon);
export const Bot = defineIcon("Bot", RobotIcon);
export const Box = defineIcon("Box", BoxIcon);
export const CalendarDays = defineIcon("CalendarDays", Calendar03Icon);
export const ChartNoAxesColumn = defineIcon("ChartNoAxesColumn", ChartNoAxesColumnIcon);
export const CheckCircle2 = defineIcon("CheckCircle2", CheckmarkCircle02Icon);
export const CircleCheck = CheckCircle2;
export const Circle = defineIcon("Circle", CircleIcon);
export const Cloud = defineIcon("Cloud", CloudIcon);
export const Command = defineIcon("Command", CommandIcon);
export const Clock3 = defineIcon("Clock3", Clock03Icon);
export const Container = defineIcon("Container", ContainerIcon);
export const CornerLeftUp = defineIcon("CornerLeftUp", CornerLeftUpIcon);
export const Cpu = defineIcon("Cpu", CpuIcon);
export const Eraser = defineIcon("Eraser", EraserIcon);
export const FileEdit = defineIcon("FileEdit", FileEditIcon);
export const GanttChart = defineIcon("GanttChart", SquareChartGanttIcon);
export const Gauge = defineIcon("Gauge", DashboardSpeed01Icon);
export const GitBranch = defineIcon("GitBranch", GitBranchIcon);
export const GitPullRequest = defineIcon("GitPullRequest", GitPullRequestIcon);
export const HelpCircle = defineIcon("HelpCircle", HelpCircleIcon);
export const Home = defineIcon("Home", Home01Icon);
export const Inbox = defineIcon("Inbox", InboxIcon);
export const Kanban = defineIcon("Kanban", KanbanIcon);
export const Key = defineIcon("Key", Key01Icon);
export const LayoutDashboard = defineIcon("LayoutDashboard", DashboardSquare01Icon);
export const Mail = defineIcon("Mail", Mail01Icon);
export const MessagesSquare = defineIcon("MessagesSquare", BubbleChatIcon);
export const Moon = defineIcon("Moon", Moon02Icon);
export const OctagonAlert = defineIcon("OctagonAlert", OctagonAlertIcon);
export const Palette = defineIcon("Palette", PaintBoardIcon);
export const Pencil = defineIcon("Pencil", PencilIcon);
export const RotateCcw = defineIcon("RotateCcw", RotateCcwIcon);
export const Send = defineIcon("Send", SentIcon);
export const Settings = defineIcon("Settings", Settings02Icon);
export const SlidersHorizontal = defineIcon("SlidersHorizontal", SlidersHorizontalIcon);
export const Sun = defineIcon("Sun", Sun03Icon);
export const ToggleLeft = defineIcon("ToggleLeft", ToggleLeftIcon);
export const ToggleRight = defineIcon("ToggleRight", ToggleRightIcon);
export const Trash2 = defineIcon("Trash2", Delete02Icon);
export const User = defineIcon("User", UserIcon);
export const UserCheck = defineIcon("UserCheck", UserCheck01Icon);
export const UserRound = User;
export const Webhook = defineIcon("Webhook", WebhookIcon);
