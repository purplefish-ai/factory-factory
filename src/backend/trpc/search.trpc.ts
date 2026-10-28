import { SearchInputSchema } from '@/shared/search';
import { publicProcedure, router } from './trpc';

export const searchRouter = router({
  githubIssues: publicProcedure
    .input(SearchInputSchema)
    .query(({ ctx, input }) => ctx.appContext.services.searchGitHubIssues(input)),
  metadata: publicProcedure
    .input(SearchInputSchema)
    .query(({ ctx, input }) => ctx.appContext.services.metadataSearchService.search(input)),
});
