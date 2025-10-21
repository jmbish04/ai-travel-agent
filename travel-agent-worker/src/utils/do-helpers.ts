export function durableObjectIdFromName(binding: DurableObjectNamespace, name: string): DurableObjectId {
        return binding.idFromName(name);
}

export function getDurableObjectStub(binding: DurableObjectNamespace, name: string): DurableObjectStub {
        const id = durableObjectIdFromName(binding, name);
        return binding.get(id);
}

export interface DurableObjectStub {
        fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
}
