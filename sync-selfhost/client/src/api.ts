import type { Actions } from "../../server/src/actions";
import { createActionClient } from "./rpc-client";

export const api = createActionClient<typeof Actions>();
export type { ApiRequest, ApiResponse } from "./rpc-client";
