import { useInfiniteQuery, UseInfiniteQueryOptions } from '@tanstack/vue-query';

import { POOLS } from '@/constants/pools';
import QUERY_KEYS from '@/constants/queryKeys';
import { Pool } from '@/services/pool/types';

import useNetwork from '../useNetwork';
import { useTokens } from '@/providers/tokens.provider';
import { configService } from '@/services/config/config.service';
import { PoolsRepositoryFetchOptions } from '@balancer-labs/sdk';
import { flatten } from 'lodash';
import { tokenTreeLeafs } from '../usePoolHelpers';
import { balancerAPIService } from '@/services/balancer/api/balancer-api.service';
import { poolsStoreService } from '@/services/pool/pools-store.service';
import { isBalancerApiDefined } from '@/lib/utils/balancer/api';
import { bnum } from '@/lib/utils';
import { PoolFilterOptions } from '@/types/pools';
import {
  GqlPoolOrderBy,
  GqlPoolOrderDirection,
} from '@/services/api/graphql/generated/api-types';
import { ApiArgs } from '@/services/balancer/api/entities/pools';
import { mapNetworkToApiChain, mapPoolTypeToApiType } from '@/lib/utils/api';

type PoolsQueryResponse = {
  pools: Pool[];
  skip?: number;
};

export default function usePoolsQuery(filterOptions: PoolFilterOptions) {
  /**
   * COMPOSABLES
   */
  const { injectTokens } = useTokens();
  const { networkId } = useNetwork();
  let poolsRepository = initializePoolsRepository();

  /**
   * METHODS
   */

  function initializePoolsRepository() {
    return {
      fetch: async (options: PoolsRepositoryFetchOptions): Promise<Pool[]> => {
        const pools = await balancerAPIService.pools.get(getQueryArgs(options));

        const tokens = flatten(
          pools.map(pool => [
            ...pool.tokensList,
            ...tokenTreeLeafs(pool.tokens),
            pool.address,
          ])
        );
        injectTokens(tokens);

        return pools;
      },
    };
  }

  function convertSortFieldToOrderBy(
    sortField: string | undefined
  ): GqlPoolOrderBy {
    switch (sortField) {
      case 'apr':
        return GqlPoolOrderBy.Apr;
      case 'volume':
        return GqlPoolOrderBy.Volume24h;
      case 'totalLiquidity':
      default:
        return GqlPoolOrderBy.TotalLiquidity;
    }
  }

  function getQueryArgs(options: PoolsRepositoryFetchOptions): ApiArgs {
    const { tokens, poolIds, poolTypes, sortField } = filterOptions.value;
    const hasPoolIdFilters = !!poolIds?.length && poolIds?.length > 0;
    const hasPoolTypeFilters = !!poolTypes?.length;

    const tokenListFormatted =
      tokens?.map(address => address.toLowerCase()) || [];

    const orderBy = convertSortFieldToOrderBy(sortField);

    const queryArgs: ApiArgs = {
      orderBy,
      orderDirection: GqlPoolOrderDirection.Desc,
      where: {
        chainIn: [mapNetworkToApiChain(configService.network.chainId)],
        tokensIn: tokenListFormatted,
        poolTypeIn: POOLS.IncludedPoolTypes.map(mapPoolTypeToApiType),
        idNotIn: POOLS.BlockList,
      },
    };

    if (queryArgs.where && hasPoolTypeFilters && !!poolTypes?.length) {
      queryArgs.where.poolTypeIn = poolTypes.map(mapPoolTypeToApiType);
    }

    if (queryArgs.where && hasPoolIdFilters) {
      queryArgs.where.idIn = filterOptions.value.poolIds;
    }
    if (options.first) {
      queryArgs.first = filterOptions.value.first || options.first;
    }
    if (options.skip) {
      queryArgs.skip = options.skip;
    }

    return queryArgs;
  }

  function getFetchOptions(pageParam = 0): PoolsRepositoryFetchOptions {
    const fetchArgs: PoolsRepositoryFetchOptions = {};
    // const { tokens, poolIds, poolTypes } = filterOptions.value;
    // const hasTokenFilters = !!tokens?.length;
    // const hasPoolIdFilters = !!poolIds?.length;
    // const hasPoolTypeFilters = !!poolTypes?.length;

    fetchArgs.first = filterOptions.value.pageSize || POOLS.Pagination.PerPage;
    // Don't use a limit if there is a token list because the limit is applied
    // pre-filter
    // if (hasPoolTypeFilters && poolTypes.includes(PoolType.Weighted)) {
    //   fetchArgs.first = 100;
    // } else if (!hasTokenFilters && !hasPoolIdFilters && !hasPoolTypeFilters) {
    //   fetchArgs.first =
    //     filterOptions.value.pageSize || POOLS.Pagination.PerPage;
    // }

    if (pageParam && pageParam > 0) {
      fetchArgs.skip = pageParam;
    }

    return fetchArgs;
  }

  function customSort(pools: Pool[]): Pool[] {
    const poolsSortField = filterOptions.value.sortField || 'totalLiquidity';

    if (poolsSortField === 'totalLiquidity') return pools;

    if (poolsSortField === 'apr') {
      return pools.sort((a, b) => {
        const aprA = a?.apr?.max ?? 0;
        const aprB = b?.apr?.max ?? 0;
        return aprB - aprA;
      });
    } else if (poolsSortField === 'volume') {
      return pools.sort((a, b) => {
        const volumeA = bnum(a?.totalSwapVolume ?? 0);
        const volumeB = bnum(b?.totalSwapVolume ?? 0);
        return volumeB.minus(volumeA).toNumber();
      });
    }

    return pools;
  }

  /**
   *  When filterTokens changes, re-initialize the repositories as their queries
   *  need to change to filter for those tokens
   */
  watch(
    filterOptions,
    () => {
      poolsRepository = initializePoolsRepository();
      poolsStoreService.setPools([]);
    },
    { deep: true }
  );

  /**
   * QUERY KEY
   */
  const queryKey = QUERY_KEYS.Pools.All(networkId, filterOptions);

  /**
   * QUERY FUNCTION
   */
  const queryFn = async ({ pageParam = 0 }) => {
    const fetchOptions = getFetchOptions(pageParam);
    const skip = (fetchOptions.first || 0) + (fetchOptions.skip || 0);
    try {
      console.log({ fetchOptions });
      let pools: Pool[] = await poolsRepository.fetch(fetchOptions);
      if (!isBalancerApiDefined) pools = customSort(pools);

      poolsStoreService.addPools(pools);

      return {
        pools,
        skip,
      };
    } catch (e) {
      const savedPools = poolsStoreService.pools.value;
      if (savedPools && savedPools.length > 0) {
        return { pools: savedPools, skip };
      }
      throw e;
    }
  };

  const options: UseInfiniteQueryOptions<PoolsQueryResponse> = {
    getNextPageParam: (lastPage: PoolsQueryResponse) => lastPage.skip || 0,
  };

  return useInfiniteQuery<PoolsQueryResponse>(queryKey, queryFn, options);
}
