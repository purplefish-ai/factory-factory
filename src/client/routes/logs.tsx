import { keepPreviousData } from '@tanstack/react-query';
import { format } from 'date-fns';
import {
  ArrowLeft,
  CalendarIcon,
  ChevronDown,
  ChevronRight,
  Download,
  Search,
  X,
} from 'lucide-react';
import { Fragment, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Loading } from '@/frontend/components/loading';
import { PageHeader } from '@/frontend/components/page-header';
import { cn } from '@/lib/utils';
import { trpc } from '../../frontend/lib/trpc';

const PAGE_SIZE = 200;

type LogLevel = 'error' | 'warn' | 'info' | 'debug';

function getLevelBadgeVariant(level: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (level) {
    case 'error':
      return 'destructive';
    case 'warn':
      return 'default';
    case 'info':
      return 'secondary';
    default:
      return 'outline';
  }
}

function formatDateLabel(date: Date | undefined): string {
  if (!date) {
    return '';
  }
  return format(date, 'MMM d, yyyy');
}

function DatePicker({
  date,
  onSelect,
  label,
  placeholder,
}: {
  date: Date | undefined;
  onSelect: (date: Date | undefined) => void;
  label: string;
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
        {label}
      </span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className={cn(
              'h-9 w-[160px] justify-start text-left font-normal',
              !date && 'text-muted-foreground'
            )}
          >
            <CalendarIcon className="mr-2 h-4 w-4 shrink-0" />
            <span className="truncate">{date ? formatDateLabel(date) : placeholder}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            selected={date}
            onSelect={(d) => {
              onSelect(d);
              setOpen(false);
            }}
            defaultMonth={date}
            disabled={{ after: new Date() }}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}

function computeTimeRange(
  timeRange: string,
  sinceDate: Date | undefined,
  untilDate: Date | undefined
): { since?: string; until?: string } {
  if (timeRange === 'custom') {
    return {
      since: sinceDate
        ? new Date(sinceDate.getFullYear(), sinceDate.getMonth(), sinceDate.getDate()).toISOString()
        : undefined,
      until: untilDate
        ? new Date(
            untilDate.getFullYear(),
            untilDate.getMonth(),
            untilDate.getDate(),
            23,
            59,
            59,
            999
          ).toISOString()
        : undefined,
    };
  }
  if (timeRange !== 'all') {
    return { since: new Date(Date.now() - Number.parseInt(timeRange, 10) * 60_000).toISOString() };
  }
  return {};
}

export default function LogsPage() {
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [level, setLevel] = useState<LogLevel | 'all'>('all');
  const [timeRange, setTimeRange] = useState<string>('all');
  const [sinceDate, setSinceDate] = useState<Date | undefined>();
  const [untilDate, setUntilDate] = useState<Date | undefined>();
  const [offset, setOffset] = useState(0);
  const [isDownloading, setIsDownloading] = useState(false);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setOffset(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const handleLevelChange = (v: string) => {
    setLevel(v as LogLevel | 'all');
    setOffset(0);
  };

  const handleTimeRangeChange = (v: string) => {
    setTimeRange(v);
    if (v !== 'custom') {
      setSinceDate(undefined);
      setUntilDate(undefined);
    }
    setOffset(0);
  };

  const handleSinceDateChange = (date: Date | undefined) => {
    setSinceDate(date);
    setTimeRange('custom');
    setOffset(0);
  };

  const handleUntilDateChange = (date: Date | undefined) => {
    setUntilDate(date);
    setTimeRange('custom');
    setOffset(0);
  };

  const handleClearDates = () => {
    setSinceDate(undefined);
    setUntilDate(undefined);
    setTimeRange('all');
    setOffset(0);
  };

  const { since, until } = computeTimeRange(timeRange, sinceDate, untilDate);

  const { data, isLoading } = trpc.admin.getLogs.useQuery(
    {
      search: debouncedSearch || undefined,
      level: level === 'all' ? undefined : level,
      since,
      until,
      limit: PAGE_SIZE,
      offset,
    },
    { refetchInterval: 10_000, placeholderData: keepPreviousData }
  );

  const utils = trpc.useUtils();

  const handleDownload = async () => {
    setIsDownloading(true);
    try {
      const content = await utils.admin.downloadLogFile.fetch();
      const blob = new Blob([content], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `server-${new Date().toISOString().split('T')[0]}.log`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success('Log file downloaded');
    } catch (error) {
      toast.error(`Download failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsDownloading(false);
    }
  };

  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 0;
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  const toggleRow = (rowId: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) {
        next.delete(rowId);
      } else {
        next.add(rowId);
      }
      return next;
    });
  };

  if (isLoading && !data) {
    return <Loading message="Loading logs..." />;
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="space-y-4 p-6">
        <PageHeader title="Server Logs" description={data?.filePath}>
          <Link to="/admin">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="w-4 h-4 mr-1" />
              Admin
            </Button>
          </Link>
        </PageHeader>

        {/* Controls */}
        <div className="flex items-center gap-3 flex-wrap">
          <div className="relative flex-1 max-w-sm min-w-[200px]">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search messages or components..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select value={level} onValueChange={handleLevelChange}>
            <SelectTrigger className="w-[130px]">
              <SelectValue placeholder="Level" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Levels</SelectItem>
              <SelectItem value="error">Error</SelectItem>
              <SelectItem value="warn">Warn</SelectItem>
              <SelectItem value="info">Info</SelectItem>
              <SelectItem value="debug">Debug</SelectItem>
            </SelectContent>
          </Select>
          <Select value={timeRange} onValueChange={handleTimeRangeChange}>
            <SelectTrigger className="w-[150px]">
              <SelectValue placeholder="Time range" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Time</SelectItem>
              <SelectItem value="5">Last 5 minutes</SelectItem>
              <SelectItem value="15">Last 15 minutes</SelectItem>
              <SelectItem value="60">Last hour</SelectItem>
              <SelectItem value="360">Last 6 hours</SelectItem>
              <SelectItem value="1440">Last 24 hours</SelectItem>
              <SelectItem value="custom">Custom Range</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={handleDownload} disabled={isDownloading}>
            <Download className="w-4 h-4 mr-1" />
            {isDownloading ? 'Downloading...' : 'Download'}
          </Button>
        </div>

        {/* Custom date range pickers */}
        {timeRange === 'custom' && (
          <div className="flex items-end gap-3 rounded-lg border border-dashed bg-muted/30 px-4 py-3">
            <DatePicker
              date={sinceDate}
              onSelect={handleSinceDateChange}
              label="From"
              placeholder="Start date"
            />
            <div className="flex h-9 items-center">
              <span className="text-muted-foreground text-sm">&ndash;</span>
            </div>
            <DatePicker
              date={untilDate}
              onSelect={handleUntilDateChange}
              label="To"
              placeholder="End date"
            />
            {(sinceDate || untilDate) && (
              <div className="flex h-9 items-center">
                <Button variant="ghost" size="sm" onClick={handleClearDates}>
                  <X className="w-3.5 h-3.5 mr-1" />
                  Clear
                </Button>
              </div>
            )}
          </div>
        )}

        {/* Results info */}
        <div className="text-sm text-muted-foreground">
          {data?.total ?? 0} entries
          {debouncedSearch && ' matching search'}
          {level !== 'all' && ` (${level})`}
        </div>

        {/* Table */}
        <div className="border rounded-md">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[180px]">Timestamp</TableHead>
                <TableHead className="w-[80px]">Level</TableHead>
                <TableHead className="w-[160px]">Component</TableHead>
                <TableHead>Message</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.entries.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                    No log entries found
                  </TableCell>
                </TableRow>
              )}
              {data?.entries.map((entry) => {
                // Use content-based ID that's stable across refetches
                const rowId = `${entry.timestamp}-${entry.level}-${entry.message.slice(0, 50)}`;
                const isExpanded = expandedRows.has(rowId);
                // Reconstruct full log entry for JSON display
                const fullEntry = {
                  level: entry.level,
                  timestamp: entry.timestamp,
                  message: entry.message,
                  context: entry.context,
                };
                return (
                  <Fragment key={rowId}>
                    <TableRow
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={() => toggleRow(rowId)}
                    >
                      <TableCell className="font-mono text-xs text-muted-foreground whitespace-nowrap">
                        <div className="flex items-center gap-1">
                          {isExpanded ? (
                            <ChevronDown className="w-3.5 h-3.5 shrink-0" />
                          ) : (
                            <ChevronRight className="w-3.5 h-3.5 shrink-0" />
                          )}
                          {new Date(entry.timestamp).toLocaleString()}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={getLevelBadgeVariant(entry.level)}>{entry.level}</Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{entry.component}</TableCell>
                      <TableCell className="max-w-md truncate" title={entry.message}>
                        {entry.message}
                      </TableCell>
                    </TableRow>
                    {isExpanded && (
                      <TableRow>
                        <TableCell colSpan={4} className="bg-muted/30 p-4">
                          <div className="space-y-2">
                            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                              Raw JSON
                            </div>
                            <pre className="bg-background border rounded-md p-3 text-xs overflow-x-auto max-h-96 overflow-y-auto">
                              {JSON.stringify(fullEntry, null, 2)}
                            </pre>
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between">
            <Button
              variant="outline"
              size="sm"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              Previous
            </Button>
            <span className="text-sm text-muted-foreground">
              Page {currentPage} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={currentPage >= totalPages}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              Next
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
