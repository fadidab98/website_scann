import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';

export const scanApi = createApi({
  reducerPath: 'scanApi',
  baseQuery: fetchBaseQuery({ baseUrl: 'http://localhost:3030' }), // Adjust this if your API is hosted elsewhere
  endpoints: (builder) => ({
    scanWebsite: builder.mutation({
      query: (url) => ({
        url: 'scan',
        method: 'POST',
        body: { url },
      }),
    }),
  }),
});

export const { useScanWebsiteMutation } = scanApi;