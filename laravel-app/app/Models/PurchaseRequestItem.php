<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

#[Fillable(['purchase_request_id', 'name', 'description', 'quantity', 'estimated_unit_price'])]
class PurchaseRequestItem extends Model
{
    protected function casts(): array
    {
        return [
            'quantity' => 'integer',
            'estimated_unit_price' => 'decimal:2',
        ];
    }

    public function purchaseRequest(): BelongsTo
    {
        return $this->belongsTo(PurchaseRequest::class);
    }
}
