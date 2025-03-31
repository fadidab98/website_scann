import { configureStore } from '@reduxjs/toolkit';
import { scanApi } from './scanApi';

export const store = configureStore({
  reducer: {
    [scanApi.reducerPath]: scanApi.reducer,
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware().concat(scanApi.middleware),
});