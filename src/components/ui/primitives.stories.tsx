import { InfoIcon, MagnifyingGlassIcon, PlusIcon } from '@phosphor-icons/react';
import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { toast } from 'sonner';
import { expect } from 'storybook/test';
import { Alert, AlertDescription, AlertTitle } from './alert';
import { Badge } from './badge';
import { Button } from './button';
import { Calendar } from './calendar';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from './card';
import { Checkbox } from './checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './collapsible';
import { CommandDialog, CommandInput, CommandItem, CommandList } from './command';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from './context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './dropdown-menu';
import { Input } from './input';
import { InputGroup, InputGroupAddon, InputGroupInput } from './input-group';
import { Kbd } from './kbd';
import { Label } from './label';
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from './popover';
import { Progress } from './progress';
import { RadioGroup, RadioGroupItem } from './radio-group';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from './resizable';
import { ScrollArea } from './scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';
import { Separator } from './separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from './sheet';
import {
  Sidebar,
  SidebarContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from './sidebar';
import { Skeleton } from './skeleton';
import { Slider } from './slider';
import { Toaster } from './sonner';
import { Switch } from './switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs';
import { Textarea } from './textarea';
import { Toggle } from './toggle';
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip';

const meta = {
  title: 'UI/Primitives',
  parameters: { layout: 'padded' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const FormControls: Story = {
  render: () => (
    <div className="grid w-full max-w-2xl gap-6 p-4 sm:grid-cols-2">
      <div className="space-y-3">
        <Label htmlFor="refresh-name">Workspace name</Label>
        <Input id="refresh-name" placeholder="My workspace" />
        <Input aria-label="Invalid name" aria-invalid placeholder="Invalid workspace name" />
        <Input aria-label="Disabled name" disabled value="Read only" />
        <Textarea aria-label="Description" placeholder="Describe the workspace" />
        <InputGroup>
          <InputGroupAddon>
            <MagnifyingGlassIcon />
          </InputGroupAddon>
          <InputGroupInput aria-label="Search" placeholder="Search workspaces" />
        </InputGroup>
      </div>
      <div className="space-y-4">
        <Select defaultValue="claude">
          <SelectTrigger aria-label="Agent">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="claude">Claude</SelectItem>
            <SelectItem value="codex">Codex</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2">
          <Checkbox id="refresh-check" defaultChecked />
          <Label htmlFor="refresh-check">Run checks</Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch id="refresh-switch" defaultChecked />
          <Label htmlFor="refresh-switch">Notifications</Label>
        </div>
        <RadioGroup defaultValue="local" aria-label="Execution">
          <div className="flex items-center gap-2">
            <RadioGroupItem id="refresh-local" value="local" />
            <Label htmlFor="refresh-local">Local</Label>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem id="refresh-remote" value="remote" />
            <Label htmlFor="refresh-remote">Remote</Label>
          </div>
        </RadioGroup>
        <Slider defaultValue={[25, 75]} aria-label="Range" />
        <Slider defaultValue={[50]} aria-label="Volume" />
        <Toggle aria-label="Pin workspace">Pin</Toggle>
      </div>
    </div>
  ),
};

export const Surfaces: Story = {
  render: () => (
    <div className="w-full max-w-xl space-y-4 p-4">
      <Card>
        <CardHeader>
          <CardTitle>Workspace</CardTitle>
          <CardDescription>Compact application card</CardDescription>
          <CardAction>
            <Button size="icon-xs" aria-label="Add">
              <PlusIcon />
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2">
            <Badge variant="success">Ready</Badge>
            <Badge variant="warning">Waiting</Badge>
            <Badge variant="info">Running</Badge>
          </div>
        </CardContent>
      </Card>
      <Alert>
        <InfoIcon />
        <AlertTitle>Ready to work</AlertTitle>
        <AlertDescription>Your workspace is up to date.</AlertDescription>
      </Alert>
      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">Workspace overview</TabsContent>
        <TabsContent value="activity">Recent activity</TabsContent>
      </Tabs>
      <Tabs defaultValue="overview">
        <TabsList variant="line">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">Underlined navigation</TabsContent>
        <TabsContent value="activity">Recent activity</TabsContent>
      </Tabs>
      <Separator />
      <Collapsible>
        <CollapsibleTrigger asChild>
          <Button variant="outline">Show details</Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="p-3">Additional workspace details</CollapsibleContent>
      </Collapsible>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Workspace</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>Dependency refresh</TableCell>
            <TableCell>Ready</TableCell>
          </TableRow>
        </TableBody>
      </Table>
      <Progress value={60} aria-label="Build progress" />
      <Skeleton className="h-6 w-40" />
    </div>
  ),
};

function OverlayPreview() {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-wrap gap-3 p-6">
      <Button onClick={() => setOpen(true)}>
        Commands <Kbd>⌘K</Kbd>
      </Button>
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Workspace commands"
        description="Find an action."
      >
        <CommandInput placeholder="Search commands" />
        <CommandList>
          <CommandItem onSelect={() => setOpen(false)}>Open workspace</CommandItem>
          <CommandItem onSelect={() => setOpen(false)}>Open settings</CommandItem>
        </CommandList>
      </CommandDialog>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline">Actions</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Open</DropdownMenuItem>
          <DropdownMenuItem variant="destructive">Delete</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline">Details</Button>
        </PopoverTrigger>
        <PopoverContent>
          <PopoverHeader>
            <PopoverTitle>Workspace details</PopoverTitle>
            <PopoverDescription>Current branch and status</PopoverDescription>
          </PopoverHeader>
        </PopoverContent>
      </Popover>
      <Sheet>
        <SheetTrigger asChild>
          <Button variant="outline">Open sheet</Button>
        </SheetTrigger>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Workspace settings</SheetTitle>
            <SheetDescription>Configure your workspace.</SheetDescription>
          </SheetHeader>
        </SheetContent>
      </Sheet>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline">Tooltip</Button>
        </TooltipTrigger>
        <TooltipContent>Workspace information</TooltipContent>
      </Tooltip>
      <ContextMenu>
        <ContextMenuTrigger className="rounded-md border border-dashed p-3 text-sm">
          Right-click here
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>Open workspace</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
}

export const Overlays: Story = { render: () => <OverlayPreview /> };

export const DateRange: Story = {
  render: () => (
    <Calendar
      mode="range"
      defaultMonth={new Date(2026, 8, 1)}
      selected={{ from: new Date(2026, 8, 7), to: new Date(2026, 8, 12) }}
      showWeekNumber
    />
  ),
};

export const Panels: Story = {
  render: () => (
    <div className="h-64 w-full max-w-2xl rounded-md border">
      <ResizablePanelGroup direction="horizontal">
        <ResizablePanel id="left" defaultSize="50%">
          <ScrollArea className="h-64" scrollbars="both">
            <div className="w-[600px] p-4">
              Long content for horizontal scrolling
              {Array.from({ length: 20 }, (_, index) => `Line ${index + 1}`).map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          </ScrollArea>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel id="right" defaultSize="50%">
          <div className="p-4">Resizable panel</div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  ),
};

export const SidebarLayout: Story = {
  render: () => (
    <div className="h-64 w-full max-w-3xl border">
      <SidebarProvider defaultOpen>
        <Sidebar collapsible="none">
          <SidebarContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton isActive>Workspace</SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarContent>
        </Sidebar>
        <main className="p-4">
          <SidebarTrigger />
          <p>Sidebar content</p>
        </main>
      </SidebarProvider>
    </div>
  ),
};

export const Notifications: Story = {
  render: (_, context) => (
    <div className="flex gap-3 p-4">
      <Toaster theme={context.globals.theme === 'dark' ? 'dark' : 'light'} />
      <Button onClick={() => toast.success('Workspace ready')}>Success toast</Button>
      <Button variant="outline" onClick={() => toast.error('Build failed')}>
        Error toast
      </Button>
    </div>
  ),
};

export const CompactControls: Story = {
  render: () => (
    <div className="space-y-4 p-4">
      <Button size="sm" className="h-7 w-7 px-0" aria-label="Attach file">
        <PlusIcon />
      </Button>
      <Select defaultValue="claude">
        <SelectTrigger className="h-7" aria-label="Compact agent">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="claude">Claude</SelectItem>
        </SelectContent>
      </Select>
      <Tabs defaultValue="info">
        <TabsList className="h-8">
          <TabsTrigger value="info">Info</TabsTrigger>
          <TabsTrigger value="diff">Diff</TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  ),
  play: async ({ canvas }) => {
    await expect(
      getComputedStyle(canvas.getByRole('button', { name: 'Attach file' })).paddingLeft
    ).toBe('0px');
    await expect(canvas.getByRole('combobox').getBoundingClientRect().height).toBe(28);
    await expect(canvas.getByRole('tablist').getBoundingClientRect().height).toBe(32);
  },
};
