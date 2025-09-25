// src/lib/events.ts
type Events = {
    "focus-address": { id: number | string; lngLat: [number, number] };
    "close-table": {};
};

type EventHandler<K extends keyof Events> = (data: Events[K]) => void;

class EventBus {
    private handlers: Map<keyof Events, Set<EventHandler<any>>> = new Map();

    on<K extends keyof Events>(event: K, handler: EventHandler<K>): void {
        if (!this.handlers.has(event)) {
            this.handlers.set(event, new Set());
        }
        this.handlers.get(event)!.add(handler);
    }

    off<K extends keyof Events>(event: K, handler: EventHandler<K>): void {
        const eventHandlers = this.handlers.get(event);
        if (eventHandlers) {
            eventHandlers.delete(handler);
        }
    }

    emit<K extends keyof Events>(event: K, data: Events[K]): void {
        const eventHandlers = this.handlers.get(event);
        if (eventHandlers) {
            eventHandlers.forEach(handler => handler(data));
        }
    }
}

// Export singleton instance
export const eventBus = new EventBus();
