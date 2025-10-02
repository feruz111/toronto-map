// src/lib/events.ts
type Events = {
  "focus-address": { id: number | string; lngLat: [number, number] };
  "close-table": Record<string, never>;
  "select-parcel": { parcelId: number | string };
  "select-address": {
    type: "Feature";
    geometry: {
      type: "Point";
      coordinates: [number, number];
    };
    properties: {
      address_point_id: number;
      civic_number?: string | number | null;
      street_name?: string | null;
      full_address?: string | null;
    };
  };
  "close-schools": Record<string, never>;
};

type EventHandler<K extends keyof Events> = (data: Events[K]) => void;

class EventBus {
  private handlers: Map<keyof Events, Set<EventHandler<keyof Events>>> =
    new Map();

  on<K extends keyof Events>(event: K, handler: EventHandler<K>): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    const eventHandlers = this.handlers.get(event);
    if (eventHandlers) {
      eventHandlers.add(handler as EventHandler<keyof Events>);
    }
  }

  off<K extends keyof Events>(event: K, handler: EventHandler<K>): void {
    const eventHandlers = this.handlers.get(event);
    if (eventHandlers) {
      eventHandlers.delete(handler as EventHandler<keyof Events>);
    }
  }

  emit<K extends keyof Events>(event: K, data: Events[K]): void {
    const eventHandlers = this.handlers.get(event);
    if (eventHandlers) {
      eventHandlers.forEach((handler) => {
        handler(data);
      });
    }
  }
}

// Export singleton instance
export const eventBus = new EventBus();
