import { useEffect, useMemo, useState } from 'react'
import './App.css'

async function apiRequest(path, { csrfToken, ...options } = {}) {
  const headers = {
    Accept: 'application/json',
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(csrfToken ? { 'X-CSRF-TOKEN': csrfToken } : {}),
    ...options.headers,
  }
  let response
  try {
    response = await fetch(path, { credentials: 'same-origin', ...options, headers })
  } catch {
    throw new Error('Can’t reach the server. Check that the Docker services are running.')
  }

  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const validationMessage = data.errors
      ? Object.values(data.errors).flat().join(' ')
      : null
    const error = new Error(validationMessage || data.message || 'The request could not be completed.')
    error.status = response.status
    throw error
  }
  return data
}

const emptyRequest = () => ({
  title: '',
  department: '',
  description: '',
  needed_by: '',
  items: [{ name: '', description: '', quantity: '1', estimated_unit_price: '' }],
})

const emptySupplier = () => ({
  name: '',
  contact_name: '',
  email: '',
  phone: '',
  address: '',
  is_active: true,
})

const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
const dateLabel = (value) => value
  ? new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(`${value.slice(0, 10)}T12:00:00`))
  : '—'
const statusLabel = (value) => value?.replaceAll('_', ' ') || '—'

function App() {
  const [user, setUser] = useState(null)
  const [csrfToken, setCsrfToken] = useState('')
  const [dashboard, setDashboard] = useState({ requests: [], orders: [], suppliers: [], metrics: {} })
  const [page, setPage] = useState('overview')
  const [query, setQuery] = useState('')
  const [authMode, setAuthMode] = useState('login')
  const [authForm, setAuthForm] = useState({ name: '', email: '', password: '', password_confirmation: '' })
  const [requestForm, setRequestForm] = useState(emptyRequest)
  const [supplierForm, setSupplierForm] = useState(emptySupplier)
  const [orderForm, setOrderForm] = useState(null)
  const [receivingOrder, setReceivingOrder] = useState(null)
  const [modal, setModal] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const isManager = user?.role === 'procurement' || user?.role === 'admin'
  const visibleRequests = useMemo(() => dashboard.requests.filter((item) => {
    const value = `${item.title} ${item.department} ${item.requester?.name || ''} ${item.status}`.toLowerCase()
    return value.includes(query.toLowerCase())
  }), [dashboard.requests, query])
  const visibleOrders = useMemo(() => dashboard.orders.filter((item) => {
    const value = `${item.po_number} ${item.supplier?.name || ''} ${item.purchase_request?.title || ''}`.toLowerCase()
    return value.includes(query.toLowerCase())
  }), [dashboard.orders, query])

  useEffect(() => {
    let active = true
    async function initialize() {
      try {
        const csrf = await apiRequest('/api/csrf-token')
        if (!active) return
        setCsrfToken(csrf.token)
        const session = await apiRequest('/api/auth/me')
        if (!active) return
        if (!session.user) return
        setUser(session.user)
        const data = await apiRequest('/api/procurement')
        if (active) setDashboard(data)
      } catch (requestError) {
        if (active && requestError.status !== 401) setError(requestError.message)
      } finally {
        if (active) setLoading(false)
      }
    }
    initialize()
    return () => { active = false }
  }, [])

  async function refreshDashboard(token = csrfToken) {
    const data = await apiRequest('/api/procurement', { csrfToken: token })
    setDashboard(data)
  }

  async function authenticate(event) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const path = authMode === 'login' ? '/api/auth/login' : '/api/auth/register'
      const result = await apiRequest(path, {
        method: 'POST',
        csrfToken,
        body: JSON.stringify(authForm),
      })
      const csrf = await apiRequest('/api/csrf-token')
      setCsrfToken(csrf.token)
      setUser(result.user)
      setDashboard(await apiRequest('/api/procurement', { csrfToken: csrf.token }))
      setAuthForm({ name: '', email: '', password: '', password_confirmation: '' })
      setNotice(`Welcome${result.user.name ? `, ${result.user.name.split(' ')[0]}` : ''}.`)
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusy(false)
    }
  }

  async function signOut() {
    setBusy(true)
    setError('')
    try {
      await apiRequest('/api/auth/logout', { method: 'POST', csrfToken })
      setUser(null)
      setDashboard({ requests: [], orders: [], suppliers: [], metrics: {} })
      const csrf = await apiRequest('/api/csrf-token')
      setCsrfToken(csrf.token)
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusy(false)
    }
  }

  async function runAction(action, successMessage) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await action()
      await refreshDashboard()
      setNotice(successMessage)
      setModal('')
      setOrderForm(null)
      setReceivingOrder(null)
      return true
    } catch (requestError) {
      setError(requestError.message)
      return false
    } finally {
      setBusy(false)
    }
  }

  async function submitRequest(event) {
    event.preventDefault()
    const saved = await runAction(async () => {
      await apiRequest('/api/requests', {
        method: 'POST',
        csrfToken,
        body: JSON.stringify({
          ...requestForm,
          needed_by: requestForm.needed_by || null,
          items: requestForm.items.map((item) => ({
            ...item,
            quantity: Number(item.quantity),
            estimated_unit_price: item.estimated_unit_price === '' ? null : Number(item.estimated_unit_price),
          })),
        }),
      })
    }, 'Purchase request submitted for review.')
    if (saved) setRequestForm(emptyRequest())
  }

  async function reviewRequest(request, decision) {
    await runAction(() => apiRequest(`/api/requests/${request.id}/review`, {
      method: 'POST',
      csrfToken,
      body: JSON.stringify({ decision }),
    }), `Request ${decision}.`)
  }

  function beginOrder(request) {
    setOrderForm({
      request,
      supplier_id: '',
      expected_delivery: '',
      notes: '',
      items: request.items.map((item) => ({
        id: item.id,
        name: item.name,
        quantity: item.quantity,
        unit_price: item.estimated_unit_price ?? '',
      })),
    })
    setModal('order')
  }

  async function submitOrder(event) {
    event.preventDefault()
    await runAction(async () => {
      await apiRequest(`/api/requests/${orderForm.request.id}/purchase-order`, {
        method: 'POST',
        csrfToken,
        body: JSON.stringify({
          supplier_id: Number(orderForm.supplier_id),
          expected_delivery: orderForm.expected_delivery || null,
          notes: orderForm.notes,
          items: orderForm.items.map((item) => ({ id: item.id, unit_price: Number(item.unit_price) })),
        }),
      })
    }, 'Purchase order created and sent.')
  }

  function beginReceiving(order) {
    setReceivingOrder({
      order,
      items: order.items.map((item) => ({
        id: item.id,
        name: item.name,
        quantity: item.quantity,
        received_quantity: item.received_quantity,
      })),
    })
    setModal('receiving')
  }

  async function submitReceiving(event) {
    event.preventDefault()
    await runAction(() => apiRequest(`/api/purchase-orders/${receivingOrder.order.id}/receiving`, {
      method: 'PATCH',
      csrfToken,
      body: JSON.stringify({
        items: receivingOrder.items.map((item) => ({
          id: item.id,
          received_quantity: Number(item.received_quantity),
        })),
      }),
    }), 'Delivery progress updated.')
  }

  async function submitSupplier(event) {
    event.preventDefault()
    const saved = await runAction(() => apiRequest('/api/suppliers', {
      method: 'POST',
      csrfToken,
      body: JSON.stringify(supplierForm),
    }), 'Supplier added.')
    if (saved) setSupplierForm(emptySupplier())
  }

  async function toggleSupplier(supplier) {
    await runAction(() => apiRequest(`/api/suppliers/${supplier.id}`, {
      method: 'PUT',
      csrfToken,
      body: JSON.stringify({ ...supplier, is_active: !supplier.is_active }),
    }), `Supplier ${supplier.is_active ? 'deactivated' : 'activated'}.`)
  }

  if (loading) {
    return <main className="loading-screen"><span className="spinner" /> Loading Efcharisto Nexus…</main>
  }

  if (!user) {
    return (
      <main className="auth-page">
        <div className="auth-brand"><span className="brand-mark">E</span><span>EFCHARISTO <b>NEXUS</b></span></div>
        <section className="auth-card">
          <div className="eyebrow">PROCUREMENT &amp; PURCHASING</div>
          <h1>{authMode === 'login' ? 'Welcome back' : 'Create your account'}</h1>
          <p className="muted">{authMode === 'login' ? 'Sign in to manage requests, suppliers, and purchase orders.' : 'Register as a requester to submit purchases for review.'}</p>
          {error && <div className="alert alert-error" role="alert">{error}</div>}
          <form onSubmit={authenticate} className="form-stack">
            {authMode === 'register' && <label>Full name<input required minLength="2" maxLength="120" autoComplete="name" value={authForm.name} onChange={(event) => setAuthForm({ ...authForm, name: event.target.value })} /></label>}
            <label>Work email<input required type="email" autoComplete="email" value={authForm.email} onChange={(event) => setAuthForm({ ...authForm, email: event.target.value })} /></label>
            <label>Password<input required type="password" minLength="10" autoComplete={authMode === 'login' ? 'current-password' : 'new-password'} value={authForm.password} onChange={(event) => setAuthForm({ ...authForm, password: event.target.value })} /></label>
            {authMode === 'register' && <label>Confirm password<input required type="password" minLength="10" autoComplete="new-password" value={authForm.password_confirmation} onChange={(event) => setAuthForm({ ...authForm, password_confirmation: event.target.value })} /></label>}
            <button className="button button-primary button-wide" disabled={busy}>{busy ? 'Please wait…' : authMode === 'login' ? 'Sign in' : 'Create account'}</button>
          </form>
          <p className="auth-switch">{authMode === 'login' ? 'New to Nexus?' : 'Already registered?'} <button className="text-button" onClick={() => { setAuthMode(authMode === 'login' ? 'register' : 'login'); setError('') }}>{authMode === 'login' ? 'Create an account' : 'Sign in'}</button></p>
          <p className="auth-footnote">New accounts start with requester access. Procurement and admin roles are assigned by an administrator.</p>
        </section>
        <span className="auth-copyright">EFCHARISTO NEXUS · OPERATIONS PLATFORM</span>
      </main>
    )
  }

  const navItems = [
    { id: 'overview', label: 'Overview', icon: '◫' },
    { id: 'requests', label: 'Purchase requests', icon: '▤', count: dashboard.metrics.pending },
    { id: 'orders', label: 'Purchase orders', icon: '▧' },
    ...(isManager ? [{ id: 'suppliers', label: 'Suppliers', icon: '◉' }] : []),
  ]

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand"><span className="brand-mark">E</span><span>EFCHARISTO <b>NEXUS</b><small>OPERATIONS PLATFORM</small></span></div>
        <div className="workspace-label">WORKSPACE</div>
        <nav className="primary-nav" aria-label="Main navigation">
          {navItems.map((item) => (
            <button key={item.id} className={`nav-item ${page === item.id ? 'active' : ''}`} onClick={() => { setPage(item.id); setQuery('') }}>
              <span className="nav-icon">{item.icon}</span><span>{item.label}</span>{item.count > 0 && <span className="nav-count">{item.count}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="security-note"><span className="security-dot" /><span>Secure workspace<small>Role-based access enabled</small></span></div>
          <button className="profile-button" onClick={signOut} disabled={busy}>
            <span className="avatar">{user.name.slice(0, 1).toUpperCase()}</span>
            <span className="profile-copy">{user.name}<small>{statusLabel(user.role)}</small></span>
            <span className="sign-out">↗</span>
          </button>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumb">Operations <span>/</span> <b>{navItems.find((item) => item.id === page)?.label}</b></div>
          <div className="topbar-actions">
            <label className="search-box"><span>⌕</span><input aria-label="Search" placeholder="Search anything…" value={query} onChange={(event) => setQuery(event.target.value)} /><kbd>⌘ K</kbd></label>
            {isManager && <span className="role-tag">{statusLabel(user.role)}</span>}
          </div>
        </header>

        <div className="page-content">
          {error && <div className="alert alert-error" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}>×</button></div>}
          {notice && <div className="alert alert-success" role="status"><span>{notice}</span><button aria-label="Dismiss message" onClick={() => setNotice('')}>×</button></div>}

          {page === 'overview' && (
            <Overview
              user={user}
              isManager={isManager}
              metrics={dashboard.metrics}
              requests={visibleRequests}
              orders={visibleOrders}
              onNavigate={setPage}
              onCreateRequest={() => { setRequestForm(emptyRequest()); setModal('request') }}
              onReview={reviewRequest}
              onCreateOrder={beginOrder}
              onReceive={beginReceiving}
            />
          )}
          {page === 'requests' && (
            <RequestsPage
              isManager={isManager}
              requests={visibleRequests}
              onCreateRequest={() => { setRequestForm(emptyRequest()); setModal('request') }}
              onReview={reviewRequest}
              onCreateOrder={beginOrder}
            />
          )}
          {page === 'orders' && <OrdersPage orders={visibleOrders} onReceive={beginReceiving} isManager={isManager} />}
          {page === 'suppliers' && isManager && <SuppliersPage suppliers={dashboard.suppliers} onCreate={() => { setSupplierForm(emptySupplier()); setModal('supplier') }} onToggle={toggleSupplier} />}
        </div>
      </main>

      {modal === 'request' && (
        <Modal title="New purchase request" subtitle="Tell procurement what your team needs." onClose={() => setModal('')} wide>
          <form className="form-stack" onSubmit={submitRequest}>
            <div className="form-grid">
              <label>Request title<input required minLength="3" maxLength="160" placeholder="e.g. Field team laptop refresh" value={requestForm.title} onChange={(event) => setRequestForm({ ...requestForm, title: event.target.value })} /></label>
              <label>Department<input required minLength="2" maxLength="120" placeholder="e.g. Operations" value={requestForm.department} onChange={(event) => setRequestForm({ ...requestForm, department: event.target.value })} /></label>
              <label>Needed by<input type="date" min={new Date().toISOString().slice(0, 10)} value={requestForm.needed_by} onChange={(event) => setRequestForm({ ...requestForm, needed_by: event.target.value })} /></label>
              <label className="span-two">Business justification<textarea rows="2" maxLength="2000" placeholder="Share context, requirements, or budget details." value={requestForm.description} onChange={(event) => setRequestForm({ ...requestForm, description: event.target.value })} /></label>
            </div>
            <div className="item-list-heading"><div><h3>Requested items</h3><span>Add each supply, hardware item, or equipment line.</span></div><button type="button" className="button button-secondary button-small" onClick={() => setRequestForm({ ...requestForm, items: [...requestForm.items, { name: '', description: '', quantity: '1', estimated_unit_price: '' }] })}>＋ Add item</button></div>
            <div className="line-items">
              {requestForm.items.map((item, index) => (
                <div className="line-item request-line" key={index}>
                  <label>Item name<input required minLength="2" maxLength="160" placeholder="Product or supply" value={item.name} onChange={(event) => setRequestItem(setRequestForm, requestForm, index, 'name', event.target.value)} /></label>
                  <label>Quantity<input required type="number" min="1" max="100000" value={item.quantity} onChange={(event) => setRequestItem(setRequestForm, requestForm, index, 'quantity', event.target.value)} /></label>
                  <label>Est. unit cost<input type="number" min="0" step="0.01" placeholder="Optional" value={item.estimated_unit_price} onChange={(event) => setRequestItem(setRequestForm, requestForm, index, 'estimated_unit_price', event.target.value)} /></label>
                  <button type="button" className="icon-button remove-line" aria-label={`Remove item ${index + 1}`} disabled={requestForm.items.length === 1} onClick={() => setRequestForm({ ...requestForm, items: requestForm.items.filter((_, itemIndex) => itemIndex !== index) })}>×</button>
                  <label className="line-description">Description (optional)<input maxLength="500" placeholder="Specifications, model, or notes" value={item.description} onChange={(event) => setRequestItem(setRequestForm, requestForm, index, 'description', event.target.value)} /></label>
                </div>
              ))}
            </div>
            <ModalActions onCancel={() => setModal('')} busy={busy} submitLabel="Submit for review" />
          </form>
        </Modal>
      )}

      {modal === 'order' && orderForm && (
        <Modal title="Create purchase order" subtitle={`Approved request · ${orderForm.request.title}`} onClose={() => setModal('')} wide>
          <form className="form-stack" onSubmit={submitOrder}>
            <div className="form-grid">
              <label>Supplier<select required value={orderForm.supplier_id} onChange={(event) => setOrderForm({ ...orderForm, supplier_id: event.target.value })}><option value="">Select a supplier</option>{dashboard.suppliers.filter((supplier) => supplier.is_active).map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</select></label>
              <label>Expected delivery<input type="date" min={new Date().toISOString().slice(0, 10)} value={orderForm.expected_delivery} onChange={(event) => setOrderForm({ ...orderForm, expected_delivery: event.target.value })} /></label>
              <label className="span-two">Order notes<textarea rows="2" maxLength="2000" value={orderForm.notes} onChange={(event) => setOrderForm({ ...orderForm, notes: event.target.value })} /></label>
            </div>
            <div className="item-list-heading"><div><h3>Purchase order lines</h3><span>Confirm supplier pricing before placing the order.</span></div></div>
            <div className="line-items">
              {orderForm.items.map((item, index) => (
                <div className="line-item order-line" key={item.id}>
                  <div className="line-product"><b>{item.name}</b><span>Quantity · {item.quantity}</span></div>
                  <label>Unit price<input required type="number" min="0" step="0.01" value={item.unit_price} onChange={(event) => setOrderForm({ ...orderForm, items: orderForm.items.map((line, lineIndex) => lineIndex === index ? { ...line, unit_price: event.target.value } : line) })} /></label>
                  <div className="line-total">{currency.format(Number(item.unit_price || 0) * item.quantity)}</div>
                </div>
              ))}
            </div>
            <ModalActions onCancel={() => setModal('')} busy={busy} submitLabel="Create purchase order" />
          </form>
        </Modal>
      )}

      {modal === 'receiving' && receivingOrder && (
        <Modal title="Record delivery" subtitle={`${receivingOrder.order.po_number} · ${receivingOrder.order.supplier?.name}`} onClose={() => setModal('')} wide>
          <form className="form-stack" onSubmit={submitReceiving}>
            <p className="modal-hint">Update cumulative quantities received. Previously recorded quantities cannot be reduced.</p>
            <div className="line-items">
              {receivingOrder.items.map((item, index) => (
                <div className="line-item receive-line" key={item.id}>
                  <div className="line-product"><b>{item.name}</b><span>{item.received_quantity} of {item.quantity} received</span></div>
                  <label>Received quantity<input required type="number" min={item.received_quantity} max={item.quantity} value={item.received_quantity} onChange={(event) => setReceivingOrder({ ...receivingOrder, items: receivingOrder.items.map((line, lineIndex) => lineIndex === index ? { ...line, received_quantity: event.target.value } : line) })} /></label>
                </div>
              ))}
            </div>
            <ModalActions onCancel={() => setModal('')} busy={busy} submitLabel="Save delivery progress" />
          </form>
        </Modal>
      )}

      {modal === 'supplier' && (
        <Modal title="Add supplier" subtitle="Keep your approved vendor directory up to date." onClose={() => setModal('')}>
          <form className="form-stack" onSubmit={submitSupplier}>
            <label>Supplier name<input required minLength="2" maxLength="160" value={supplierForm.name} onChange={(event) => setSupplierForm({ ...supplierForm, name: event.target.value })} /></label>
            <label>Contact name<input maxLength="120" value={supplierForm.contact_name} onChange={(event) => setSupplierForm({ ...supplierForm, contact_name: event.target.value })} /></label>
            <div className="form-grid">
              <label>Email<input type="email" maxLength="255" value={supplierForm.email} onChange={(event) => setSupplierForm({ ...supplierForm, email: event.target.value })} /></label>
              <label>Phone<input maxLength="40" value={supplierForm.phone} onChange={(event) => setSupplierForm({ ...supplierForm, phone: event.target.value })} /></label>
            </div>
            <label>Address<textarea rows="2" maxLength="1000" value={supplierForm.address} onChange={(event) => setSupplierForm({ ...supplierForm, address: event.target.value })} /></label>
            <ModalActions onCancel={() => setModal('')} busy={busy} submitLabel="Save supplier" />
          </form>
        </Modal>
      )}
    </div>
  )
}

function setRequestItem(setForm, form, index, field, value) {
  setForm({
    ...form,
    items: form.items.map((item, itemIndex) => itemIndex === index ? { ...item, [field]: value } : item),
  })
}

function Overview({ user, isManager, metrics, requests, orders, onNavigate, onCreateRequest, onReview, onCreateOrder, onReceive }) {
  const recentRequests = requests.slice(0, 5)
  const openOrders = orders.filter((order) => order.status !== 'received').slice(0, 4)
  return (
    <>
      <div className="page-heading">
        <div><div className="eyebrow">PROCUREMENT OVERVIEW</div><h1>Good day, {user.name.split(' ')[0]}</h1><p>Here’s what’s happening across your purchasing workflow.</p></div>
        <button className="button button-primary" onClick={onCreateRequest}><span>＋</span> New request</button>
      </div>
      <section className="metric-grid">
        <MetricCard label="Awaiting review" value={metrics.pending || 0} tone="amber" icon="◷" detail={isManager ? 'Requests need your attention' : 'Submitted for approval'} />
        <MetricCard label="Approved requests" value={metrics.approved || 0} tone="violet" icon="✓" detail="Ready for purchase orders" />
        <MetricCard label="Open purchase orders" value={metrics.open_orders || 0} tone="blue" icon="▧" detail="Ordered or partially received" />
        <MetricCard label="Received this cycle" value={metrics.received || 0} tone="green" icon="↙" detail="Orders fully delivered" />
      </section>
      <div className="dashboard-grid">
        <section className="panel recent-panel">
          <div className="panel-heading"><div><h2>Recent purchase requests</h2><p>Latest activity from your team</p></div><button className="text-button" onClick={() => onNavigate('requests')}>View all <span>→</span></button></div>
          {recentRequests.length ? <RequestTable requests={recentRequests} isManager={isManager} onReview={onReview} onCreateOrder={onCreateOrder} /> : <EmptyState title="No purchase requests yet" detail="Create a request to start a purchasing workflow." actionLabel="Create request" onAction={onCreateRequest} />}
        </section>
        <section className="panel orders-panel">
          <div className="panel-heading"><div><h2>Open purchase orders</h2><p>Track deliveries in progress</p></div><button className="text-button" onClick={() => onNavigate('orders')}>View all <span>→</span></button></div>
          {openOrders.length ? <div className="order-list">{openOrders.map((order) => <OrderRow key={order.id} order={order} onReceive={onReceive} isManager={isManager} />)}</div> : <EmptyState title="No open orders" detail="Approved requests can be converted into purchase orders." />}
        </section>
      </div>
      {isManager && <section className="workflow-banner"><div className="workflow-icon">✦</div><div><b>Keep purchasing moving</b><p>Review new requests, maintain supplier records, and track incoming deliveries in one place.</p></div><button className="button button-secondary" onClick={() => onNavigate('requests')}>Review requests <span>→</span></button></section>}
    </>
  )
}

function MetricCard({ label, value, tone, icon, detail }) {
  return <article className="metric-card"><div className={`metric-icon ${tone}`}>{icon}</div><span className="metric-label">{label}</span><strong>{value}</strong><span className="metric-detail">{detail}</span></article>
}

function RequestsPage({ isManager, requests, onCreateRequest, onReview, onCreateOrder }) {
  return (
    <>
      <div className="page-heading"><div><div className="eyebrow">PURCHASING WORKFLOW</div><h1>Purchase requests</h1><p>{isManager ? 'Review incoming needs and turn approved requests into orders.' : 'Submit and track your team’s purchase requests.'}</p></div><button className="button button-primary" onClick={onCreateRequest}><span>＋</span> New request</button></div>
      <section className="panel table-panel"><div className="panel-heading"><div><h2>All requests <span className="heading-count">{requests.length}</span></h2><p>Requests are visible to their submitter and procurement staff.</p></div></div><RequestTable requests={requests} isManager={isManager} onReview={onReview} onCreateOrder={onCreateOrder} /></section>
    </>
  )
}

function RequestTable({ requests, isManager, onReview, onCreateOrder }) {
  if (!requests.length) return <EmptyState title="Nothing to show" detail="New purchase requests will appear here." />
  return (
    <div className="table-scroll"><table><thead><tr><th>Request</th><th>Requester</th><th>Needed by</th><th>Items</th><th>Status</th>{isManager && <th className="actions-head">Action</th>}</tr></thead><tbody>
      {requests.map((request) => <tr key={request.id}>
        <td><div className="primary-cell">{request.title}</div><div className="secondary-cell">{request.department}</div>{request.review_note && <div className="request-review-note" title={request.review_note}>Review note: {request.review_note}</div>}</td>
        <td>{request.requester?.name || 'You'}</td><td>{dateLabel(request.needed_by)}</td><td>{request.items.length} {request.items.length === 1 ? 'line' : 'lines'}</td>
        <td><StatusBadge status={request.status} /></td>
        {isManager && <td className="row-actions">{request.status === 'pending' ? <><button className="mini-action approve" onClick={() => onReview(request, 'approved')}>Approve</button><button className="mini-action reject" onClick={() => onReview(request, 'rejected')}>Decline</button></> : request.status === 'approved' ? <button className="mini-action create-order" onClick={() => onCreateOrder(request)}>Create order</button> : request.purchase_order && <span className="secondary-cell">{request.purchase_order.po_number}</span>}</td>}
      </tr>)}
    </tbody></table></div>
  )
}

function OrdersPage({ orders, onReceive, isManager }) {
  return (
    <>
      <div className="page-heading"><div><div className="eyebrow">SUPPLIER COMMITMENTS</div><h1>Purchase orders</h1><p>Monitor placed orders and keep delivery progress up to date.</p></div></div>
      <section className="panel table-panel"><div className="panel-heading"><div><h2>Order register <span className="heading-count">{orders.length}</span></h2><p>Orders are created from approved purchase requests.</p></div></div>
        {orders.length ? <div className="table-scroll"><table><thead><tr><th>Purchase order</th><th>Request</th><th>Supplier</th><th>Expected</th><th>Status</th>{isManager && <th className="actions-head">Action</th>}</tr></thead><tbody>{orders.map((order) => <tr key={order.id}><td><div className="primary-cell">{order.po_number}</div><div className="secondary-cell">{dateLabel(order.ordered_at)}</div></td><td>{order.purchase_request?.title}</td><td>{order.supplier?.name}</td><td>{dateLabel(order.expected_delivery)}</td><td><StatusBadge status={order.status} /></td>{isManager && <td className="row-actions">{order.status !== 'received' && <button className="mini-action create-order" onClick={() => onReceive(order)}>Record delivery</button>}</td>}</tr>)}</tbody></table></div> : <EmptyState title="No purchase orders" detail="Purchase orders appear here once an approved request is placed with a supplier." />}
      </section>
      {orders.length > 0 && <section className="panel order-detail-panel"><div className="panel-heading"><div><h2>Line-item delivery progress</h2><p>Track the quantities received against each order.</p></div></div><div className="delivery-grid">{orders.map((order) => <article className="delivery-card" key={order.id}><div className="delivery-card-head"><b>{order.po_number}</b><StatusBadge status={order.status} /></div><span className="secondary-cell">{order.supplier?.name} · {order.purchase_request?.title}</span>{order.items.map((item) => <div className="progress-line" key={item.id}><div><span>{item.name}</span><b>{item.received_quantity} / {item.quantity}</b></div><div className="progress-track"><span style={{ width: `${Math.min(100, item.received_quantity / item.quantity * 100)}%` }} /></div></div>)}</article>)}</div></section>}
    </>
  )
}

function OrderRow({ order, onReceive, isManager }) {
  const progress = order.items.reduce((sum, item) => sum + item.received_quantity, 0)
  const total = order.items.reduce((sum, item) => sum + item.quantity, 0)
  return <article className="order-row"><div className="order-row-top"><div><span className="order-number">{order.po_number}</span><span className="order-date">{dateLabel(order.expected_delivery)}</span></div><StatusBadge status={order.status} /></div><b className="order-supplier">{order.supplier?.name}</b><div className="order-progress-copy"><span>Delivery progress</span><b>{progress} / {total} units</b></div><div className="progress-track"><span style={{ width: `${total ? progress / total * 100 : 0}%` }} /></div>{isManager && <button className="text-button receive-action" onClick={() => onReceive(order)}>Record delivery <span>→</span></button>}</article>
}

function SuppliersPage({ suppliers, onCreate, onToggle }) {
  return (
    <>
      <div className="page-heading"><div><div className="eyebrow">VENDOR DIRECTORY</div><h1>Suppliers</h1><p>Manage approved vendors for hardware, supplies, and equipment.</p></div><button className="button button-primary" onClick={onCreate}><span>＋</span> Add supplier</button></div>
      <section className="panel table-panel"><div className="panel-heading"><div><h2>Supplier directory <span className="heading-count">{suppliers.length}</span></h2><p>Only active suppliers can be selected on new purchase orders.</p></div></div>
        {suppliers.length ? <div className="table-scroll"><table><thead><tr><th>Supplier</th><th>Contact</th><th>Email / phone</th><th>Address</th><th>Status</th><th className="actions-head">Action</th></tr></thead><tbody>{suppliers.map((supplier) => <tr key={supplier.id}><td><div className="supplier-name-cell"><span className="supplier-monogram">{supplier.name.slice(0, 1).toUpperCase()}</span><b>{supplier.name}</b></div></td><td>{supplier.contact_name || '—'}</td><td><div>{supplier.email || '—'}</div><div className="secondary-cell">{supplier.phone}</div></td><td className="address-cell">{supplier.address || '—'}</td><td><StatusBadge status={supplier.is_active ? 'active' : 'inactive'} /></td><td><button className={`mini-action ${supplier.is_active ? 'reject' : 'approve'}`} onClick={() => onToggle(supplier)}>{supplier.is_active ? 'Deactivate' : 'Activate'}</button></td></tr>)}</tbody></table></div> : <EmptyState title="Your supplier directory is empty" detail="Add a supplier before creating your first purchase order." actionLabel="Add supplier" onAction={onCreate} />}
      </section>
    </>
  )
}

function StatusBadge({ status }) {
  const tone = ['approved', 'received', 'active'].includes(status) ? 'green' : ['rejected', 'inactive'].includes(status) ? 'red' : ['ordered', 'partially_received'].includes(status) ? 'blue' : 'amber'
  return <span className={`status-badge ${tone}`}><span />{statusLabel(status)}</span>
}

function EmptyState({ title, detail, actionLabel, onAction }) {
  return <div className="empty-state"><span className="empty-symbol">⌑</span><b>{title}</b><p>{detail}</p>{actionLabel && <button className="button button-secondary button-small" onClick={onAction}>{actionLabel}</button>}</div>
}

function Modal({ title, subtitle, onClose, wide = false, children }) {
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section className={`modal-card ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby="modal-title"><header className="modal-header"><div><h2 id="modal-title">{title}</h2><p>{subtitle}</p></div><button className="icon-button modal-close" aria-label="Close dialog" onClick={onClose}>×</button></header>{children}</section></div>
}

function ModalActions({ onCancel, busy, submitLabel }) {
  return <div className="modal-actions"><button type="button" className="button button-secondary" onClick={onCancel} disabled={busy}>Cancel</button><button className="button button-primary" disabled={busy}>{busy ? 'Saving…' : submitLabel}</button></div>
}

export default App
