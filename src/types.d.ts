import type {
  ContainerTaskSpec,
  Endpoint,
  JobStatus,
  Meta,
  SecretSpec,
  ServiceSpec,
  ServiceStatus,
  UpdateStatus,
} from "dockerode";

/**
 * @see https://docs.docker.com/reference/api/engine/version/v1.49/#tag/Task/operation/TaskList
 */
export interface TaskInfo {
  ID: string;
  ServiceID: string;
  NodeID: string;
  DesiredState: TaskState;
  Labels: Record<string, string>;
  CreatedAt: string;
  UpdatedAt: string;
  Status: {
    State: TaskState;
    Message?: string;
    Err?: string;
    [key: string]: unknown;
  };
  Spec: Partial<ContainerTaskSpec>;

  [key: string]: unknown;
}

export type TaskState =
  | "new"
  | "allocated"
  | "pending"
  | "assigned"
  | "accepted"
  | "preparing"
  | "ready"
  | "starting"
  | "running"
  | "complete"
  | "shutdown"
  | "failed"
  | "rejected"
  | "remove"
  | "orphaned";

export interface SecretInfo extends Meta {
  ID: string;
  Spec?: Omit<SecretSpec, "Data">;
}

export interface ServiceInfo extends Meta {
  ID: string;
  Spec?: ServiceSpec;
  PreviousSpec?: ServiceSpec;
  Endpoint?: Endpoint;
  UpdateStatus?: UpdateStatus;
  ServiceStatus?: ServiceStatus;
  JobStatus?: JobStatus;
}
