<?php

namespace Tests\Feature;

use App\Models\PurchaseRequest;
use App\Models\Supplier;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class ProcurementWorkflowTest extends TestCase
{
    use RefreshDatabase;

    public function test_requester_can_submit_and_track_a_request_while_procurement_completes_the_order(): void
    {
        $requester = $this->user('requester');
        $procurement = $this->user('procurement');
        $supplier = Supplier::create([
            'name' => 'Northstar Hardware',
            'is_active' => true,
        ]);

        $this->actingAs($requester)->postJson('/api/requests', [
            'title' => 'Field laptop refresh',
            'department' => 'Operations',
            'items' => [
                ['name' => 'Rugged laptop', 'quantity' => 4, 'estimated_unit_price' => '1200.00'],
            ],
        ])->assertCreated()
            ->assertJsonPath('request.status', 'pending');

        $purchaseRequest = PurchaseRequest::with('items')->firstOrFail();
        $this->actingAs($procurement)->postJson("/api/requests/{$purchaseRequest->id}/review", [
            'decision' => 'approved',
        ])->assertOk()
            ->assertJsonPath('request.status', 'approved');

        $this->postJson("/api/requests/{$purchaseRequest->id}/purchase-order", [
            'supplier_id' => $supplier->id,
            'items' => [
                ['id' => $purchaseRequest->items[0]->id, 'unit_price' => '1150.00'],
            ],
        ])->assertCreated()
            ->assertJsonPath('order.status', 'ordered');

        $order = $purchaseRequest->fresh()->purchaseOrder()->with('items')->firstOrFail();
        $this->patchJson("/api/purchase-orders/{$order->id}/receiving", [
            'items' => [
                ['id' => $order->items[0]->id, 'received_quantity' => 2],
            ],
        ])->assertOk()
            ->assertJsonPath('order.status', 'partially_received');

        $this->patchJson("/api/purchase-orders/{$order->id}/receiving", [
            'items' => [
                ['id' => $order->items[0]->id, 'received_quantity' => 4],
            ],
        ])->assertOk()
            ->assertJsonPath('order.status', 'received');

        $this->actingAs($requester)->getJson('/api/procurement')
            ->assertOk()
            ->assertJsonPath('requests.0.status', 'received')
            ->assertJsonCount(1, 'orders');
    }

    public function test_requesters_cannot_review_requests_or_manage_suppliers(): void
    {
        $requester = $this->user('requester');
        $purchaseRequest = PurchaseRequest::create([
            'requester_id' => $requester->id,
            'title' => 'Office equipment',
            'department' => 'Operations',
            'status' => 'pending',
        ]);

        $this->actingAs($requester)->postJson("/api/requests/{$purchaseRequest->id}/review", [
            'decision' => 'approved',
        ])->assertForbidden();

        $this->postJson('/api/suppliers', [
            'name' => 'Unapproved access',
            'is_active' => true,
        ])->assertForbidden();
    }

    public function test_registration_always_creates_a_requester_account(): void
    {
        $this->postJson('/api/auth/register', [
            'name' => 'New Teammate',
            'email' => 'new@example.com',
            'password' => 'secure-password-123',
            'password_confirmation' => 'secure-password-123',
            'role' => 'admin',
        ])->assertCreated()
            ->assertJsonPath('user.role', 'requester');
    }

    public function test_guest_can_check_authentication_state_without_receiving_an_error(): void
    {
        $this->getJson('/api/auth/me')
            ->assertOk()
            ->assertExactJson(['user' => null]);
    }

    private function user(string $role): User
    {
        return User::create([
            'name' => ucfirst($role).' User',
            'email' => $role.'@example.com',
            'password' => 'secure-password-123',
            'role' => $role,
        ]);
    }
}
