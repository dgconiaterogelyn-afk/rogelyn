<?php

namespace App\Http\Controllers;

use App\Models\PurchaseOrder;
use App\Models\PurchaseRequest as ProcurementRequest;
use App\Models\Supplier;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

class ProcurementController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        $user = $request->user();
        $canManage = $user->canManageProcurement();
        $requests = ProcurementRequest::query()
            ->when(! $canManage, fn ($query) => $query->where('requester_id', $user->id))
            ->with(['requester:id,name,email', 'reviewer:id,name', 'items', 'purchaseOrder.supplier', 'purchaseOrder.items'])
            ->latest()
            ->get();
        $orders = PurchaseOrder::query()
            ->when(! $canManage, fn ($query) => $query->whereHas(
                'purchaseRequest',
                fn ($purchaseQuery) => $purchaseQuery->where('requester_id', $user->id),
            ))
            ->with(['supplier:id,name', 'purchaseRequest:id,title,requester_id', 'items'])
            ->latest()
            ->get();

        return response()->json([
            'requests' => $requests,
            'orders' => $orders,
            'suppliers' => $canManage ? Supplier::query()->orderBy('name')->get() : [],
            'metrics' => [
                'pending' => $requests->where('status', 'pending')->count(),
                'approved' => $requests->where('status', 'approved')->count(),
                'open_orders' => $orders->whereIn('status', ['ordered', 'partially_received'])->count(),
                'received' => $orders->where('status', 'received')->count(),
            ],
        ]);
    }

    public function storeRequest(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'title' => ['required', 'string', 'min:3', 'max:160'],
            'department' => ['required', 'string', 'min:2', 'max:120'],
            'description' => ['nullable', 'string', 'max:2000'],
            'needed_by' => ['nullable', 'date', 'after_or_equal:today'],
            'items' => ['required', 'array', 'min:1', 'max:50'],
            'items.*.name' => ['required', 'string', 'min:2', 'max:160'],
            'items.*.description' => ['nullable', 'string', 'max:500'],
            'items.*.quantity' => ['required', 'integer', 'min:1', 'max:100000'],
            'items.*.estimated_unit_price' => ['nullable', 'numeric', 'min:0', 'max:9999999999.99', 'decimal:0,2'],
        ]);

        $purchaseRequest = DB::transaction(function () use ($validated, $request): ProcurementRequest {
            $purchaseRequest = ProcurementRequest::create([
                'requester_id' => $request->user()->id,
                'title' => $validated['title'],
                'department' => $validated['department'],
                'description' => $validated['description'] ?? null,
                'needed_by' => $validated['needed_by'] ?? null,
                'status' => 'pending',
            ]);
            $purchaseRequest->items()->createMany($validated['items']);

            return $purchaseRequest;
        });

        return response()->json([
            'request' => $purchaseRequest->load(['requester:id,name,email', 'items']),
        ], 201);
    }

    public function reviewRequest(Request $request, ProcurementRequest $purchaseRequest): JsonResponse
    {
        $this->authorizeProcurement($request);
        $validated = $request->validate([
            'decision' => ['required', 'in:approved,rejected'],
            'review_note' => ['nullable', 'string', 'max:1000'],
        ]);

        $purchaseRequest = DB::transaction(function () use ($request, $purchaseRequest, $validated): ProcurementRequest {
            $lockedRequest = ProcurementRequest::query()->lockForUpdate()->findOrFail($purchaseRequest->id);
            abort_unless($lockedRequest->status === 'pending', 409, 'Only pending requests can be reviewed.');

            $lockedRequest->update([
                'status' => $validated['decision'],
                'reviewed_by' => $request->user()->id,
                'reviewed_at' => now(),
                'review_note' => $validated['review_note'] ?? null,
            ]);

            return $lockedRequest;
        });

        return response()->json(['request' => $purchaseRequest->load(['requester:id,name,email', 'reviewer:id,name', 'items'])]);
    }

    public function createPurchaseOrder(Request $request, ProcurementRequest $purchaseRequest): JsonResponse
    {
        $this->authorizeProcurement($request);
        $validated = $request->validate([
            'supplier_id' => ['required', 'integer', 'exists:suppliers,id'],
            'expected_delivery' => ['nullable', 'date', 'after_or_equal:today'],
            'notes' => ['nullable', 'string', 'max:2000'],
            'items' => ['required', 'array', 'min:1', 'max:50'],
            'items.*.id' => ['required', 'integer', 'distinct', 'exists:purchase_request_items,id'],
            'items.*.unit_price' => ['required', 'numeric', 'min:0', 'max:9999999999.99', 'decimal:0,2'],
        ]);

        $purchaseOrder = DB::transaction(function () use ($request, $purchaseRequest, $validated): PurchaseOrder {
            $lockedRequest = ProcurementRequest::query()
                ->with('items')
                ->lockForUpdate()
                ->findOrFail($purchaseRequest->id);
            abort_unless($lockedRequest->status === 'approved', 409, 'A purchase order can only be created from an approved request.');

            $supplier = Supplier::query()->lockForUpdate()->findOrFail($validated['supplier_id']);
            abort_unless($supplier->is_active, 422, 'Select an active supplier.');

            $expectedIds = $lockedRequest->items->pluck('id')->sort()->values()->all();
            $submittedIds = collect($validated['items'])->pluck('id')->map(fn ($id) => (int) $id)->sort()->values()->all();
            abort_unless($submittedIds === $expectedIds, 422, 'Include each requested item exactly once.');

            $purchaseOrder = PurchaseOrder::create([
                'po_number' => 'PO-'.now()->format('Ymd').'-'.Str::upper(Str::random(8)),
                'purchase_request_id' => $lockedRequest->id,
                'supplier_id' => $supplier->id,
                'created_by' => $request->user()->id,
                'status' => 'ordered',
                'expected_delivery' => $validated['expected_delivery'] ?? null,
                'ordered_at' => now(),
                'notes' => $validated['notes'] ?? null,
            ]);

            $prices = collect($validated['items'])->keyBy('id');
            foreach ($lockedRequest->items as $item) {
                $purchaseOrder->items()->create([
                    'purchase_request_item_id' => $item->id,
                    'name' => $item->name,
                    'quantity' => $item->quantity,
                    'unit_price' => $prices->get($item->id)['unit_price'],
                ]);
            }

            $lockedRequest->update(['status' => 'ordered']);

            return $purchaseOrder;
        });

        return response()->json([
            'order' => $purchaseOrder->load(['supplier:id,name', 'purchaseRequest:id,title,requester_id', 'items']),
        ], 201);
    }

    public function receivePurchaseOrder(Request $request, PurchaseOrder $purchaseOrder): JsonResponse
    {
        $this->authorizeProcurement($request);
        $validated = $request->validate([
            'items' => ['required', 'array', 'min:1', 'max:50'],
            'items.*.id' => ['required', 'integer', 'distinct', 'exists:purchase_order_items,id'],
            'items.*.received_quantity' => ['required', 'integer', 'min:0', 'max:100000'],
        ]);

        $purchaseOrder = DB::transaction(function () use ($purchaseOrder, $validated): PurchaseOrder {
            $lockedOrder = PurchaseOrder::query()
                ->with(['items', 'purchaseRequest'])
                ->lockForUpdate()
                ->findOrFail($purchaseOrder->id);
            abort_unless(in_array($lockedOrder->status, ['ordered', 'partially_received'], true), 409, 'This order is no longer open for receiving.');

            $expectedIds = $lockedOrder->items->pluck('id')->sort()->values()->all();
            $submittedIds = collect($validated['items'])->pluck('id')->map(fn ($id) => (int) $id)->sort()->values()->all();
            abort_unless($submittedIds === $expectedIds, 422, 'Include each order item exactly once.');

            $quantities = collect($validated['items'])->keyBy('id');
            foreach ($lockedOrder->items as $item) {
                $receivedQuantity = (int) $quantities->get($item->id)['received_quantity'];
                abort_unless($receivedQuantity >= $item->received_quantity, 422, 'Received quantities cannot be decreased.');
                abort_unless($receivedQuantity <= $item->quantity, 422, 'Received quantities cannot exceed the ordered quantity.');
                $item->update(['received_quantity' => $receivedQuantity]);
            }

            $allReceived = $lockedOrder->items->every(
                fn ($item) => (int) $quantities->get($item->id)['received_quantity'] === $item->quantity,
            );
            $someReceived = $lockedOrder->items->contains(
                fn ($item) => (int) $quantities->get($item->id)['received_quantity'] > 0,
            );
            $status = $allReceived ? 'received' : ($someReceived ? 'partially_received' : 'ordered');

            $lockedOrder->update([
                'status' => $status,
                'received_at' => $status === 'received' ? now() : null,
            ]);
            $lockedOrder->purchaseRequest()->update(['status' => $status]);

            return $lockedOrder->refresh();
        });

        return response()->json([
            'order' => $purchaseOrder->load(['supplier:id,name', 'purchaseRequest:id,title,requester_id', 'items']),
        ]);
    }

    public function storeSupplier(Request $request): JsonResponse
    {
        $this->authorizeProcurement($request);
        $supplier = Supplier::create($this->validateSupplier($request));

        return response()->json(['supplier' => $supplier], 201);
    }

    public function updateSupplier(Request $request, Supplier $supplier): JsonResponse
    {
        $this->authorizeProcurement($request);
        $supplier->update($this->validateSupplier($request, $supplier));

        return response()->json(['supplier' => $supplier->refresh()]);
    }

    private function validateSupplier(Request $request, ?Supplier $supplier = null): array
    {
        $uniqueName = 'unique:suppliers,name'.($supplier ? ','.$supplier->id : '');

        return $request->validate([
            'name' => ['required', 'string', 'min:2', 'max:160', $uniqueName],
            'contact_name' => ['nullable', 'string', 'max:120'],
            'email' => ['nullable', 'email', 'max:255'],
            'phone' => ['nullable', 'string', 'max:40'],
            'address' => ['nullable', 'string', 'max:1000'],
            'is_active' => ['required', 'boolean'],
        ]);
    }

    private function authorizeProcurement(Request $request): void
    {
        abort_unless($request->user()->canManageProcurement(), 403, 'Procurement access is required.');
    }
}
