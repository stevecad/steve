"""Shared native controls: consistent drawing, spacing, focus and popup behavior."""
from PySide6.QtCore import Qt, QRectF, QPointF, QSize, QPoint
from PySide6.QtGui import QColor, QPainter, QPen, QFont, QIcon, QPixmap
from PySide6.QtWidgets import (QComboBox, QFrame, QVBoxLayout, QHBoxLayout, QLabel,
    QListWidget, QListWidgetItem, QPushButton, QCheckBox, QWidget, QStyledItemDelegate,
    QStyle, QSizePolicy)


def icon(name, color='#a6b4ae', size=20):
    pix = QPixmap(size * 2, size * 2)
    pix.setDevicePixelRatio(2)
    pix.fill(Qt.GlobalColor.transparent)
    p = QPainter(pix)
    p.setRenderHint(QPainter.RenderHint.Antialiasing)
    p.scale(size / 24, size / 24)
    p.setPen(QPen(QColor(color), 1.6, Qt.PenStyle.SolidLine, Qt.PenCapStyle.RoundCap, Qt.PenJoinStyle.RoundJoin))
    if name == 'plus':
        p.drawLine(12, 5, 12, 19); p.drawLine(5, 12, 19, 12)
    elif name == 'account':
        p.drawEllipse(QRectF(8, 3, 8, 8)); p.drawArc(QRectF(4, 13, 16, 12), 0, 180 * 16)
    elif name == 'plug':
        p.drawLine(8, 3, 8, 9); p.drawLine(16, 3, 16, 9)
        p.drawRoundedRect(QRectF(5, 8, 14, 9), 3, 3); p.drawLine(12, 17, 12, 22)
    elif name == 'sliders':
        for y, x in ((6, 8), (12, 16), (18, 10)):
            p.drawLine(4, y, 20, y)
            p.setBrush(QColor('#141c20')); p.drawEllipse(QPointF(x, y), 2, 2)
    elif name == 'settings':
        p.drawEllipse(QRectF(5, 5, 14, 14)); p.drawEllipse(QRectF(9, 9, 6, 6))
        for a,b,c,d in ((12,2,12,5),(12,19,12,22),(2,12,5,12),(19,12,22,12),(5,5,7,7),(17,17,19,19),(5,19,7,17),(17,7,19,5)):
            p.drawLine(a,b,c,d)
    elif name == 'chat':
        p.drawRoundedRect(QRectF(3, 4, 18, 14), 4, 4); p.drawLine(7,18,7,21);p.drawLine(7,21,11,18)
    elif name == 'logout':
        p.drawLine(10,4,4,4);p.drawLine(4,4,4,20);p.drawLine(4,20,10,20)
        p.drawLine(10,12,21,12);p.drawLine(17,8,21,12);p.drawLine(17,16,21,12)
    p.end()
    return QIcon(pix)


class AccordionButton(QPushButton):
    def __init__(self, text='Settings', parent=None):
        super().__init__(text, parent)
        self.setCheckable(True)
        self.setFixedHeight(46)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setAccessibleName(text)

    def paintEvent(self, event):
        p = QPainter(self); p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(QColor('#202b2b' if self.underMouse() or self.isChecked() else '#141c20'))
        p.drawRoundedRect(QRectF(self.rect()).adjusted(0,0,-1,-1), 10, 10)
        icon('settings').paint(p, 12, 13, 20, 20)
        p.setFont(self.font());p.setPen(QColor('#d8e2dd'))
        p.drawText(self.rect().adjusted(44,0,-30,0), Qt.AlignmentFlag.AlignVCenter, 'Settings')
        x,y = self.width()-22, self.height()/2
        p.setPen(QPen(QColor('#99aaa2'),1.6))
        dy = -3 if self.isChecked() else 3
        p.drawLine(QPointF(x-4,y-dy/2),QPointF(x,y+dy/2))
        p.drawLine(QPointF(x,y+dy/2),QPointF(x+4,y-dy/2))
        if self.hasFocus():
            p.setBrush(Qt.BrushStyle.NoBrush);p.setPen(QColor('#8bc6ac'))
            p.drawRoundedRect(QRectF(self.rect()).adjusted(1,1,-2,-2),9,9)


class ChoiceDelegate(QStyledItemDelegate):
    def paint(self, painter, option, index):
        painter.save();painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        hovered = bool(option.state & QStyle.StateFlag.State_Selected)
        if hovered:
            painter.setPen(Qt.PenStyle.NoPen);painter.setBrush(QColor('#293b34'))
            painter.drawRoundedRect(QRectF(option.rect).adjusted(3,2,-3,-2),7,7)
        painter.setFont(option.font);painter.setPen(QColor('#edf3ef'))
        painter.drawText(option.rect.adjusted(14,0,-34,0),Qt.AlignmentFlag.AlignVCenter,str(index.data()))
        if index.data(Qt.ItemDataRole.UserRole + 1):
            x,y = option.rect.right()-20, option.rect.center().y()
            painter.setPen(QPen(QColor('#b2e5c9'),1.8))
            painter.drawLine(x-5,y,x-1,y+4);painter.drawLine(x-1,y+4,x+6,y-4)
        painter.restore()

    def sizeHint(self, option, index):
        return QSize(240, 42)


class ChoiceBox(QComboBox):
    """ComboBox semantics with a fully drawn trigger and keyboard-accessible popover."""
    def __init__(self, parent=None, title='Choose an option'):
        super().__init__(parent)
        self.popup_title = title
        self.popup = None
        self.setFixedHeight(40)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.currentIndexChanged.connect(lambda _: self.update())
        self.setSizeAdjustPolicy(QComboBox.SizeAdjustPolicy.AdjustToContents)

    def paintEvent(self, event):
        p=QPainter(self);p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.setPen(QPen(QColor('#7ba38d' if self.hasFocus() else '#394741' if self.underMouse() else '#2b3734'),1))
        p.setBrush(QColor('#202b28' if self.underMouse() else '#192220'))
        p.drawRoundedRect(QRectF(self.rect()).adjusted(.5,.5,-.5,-.5),9,9)
        p.setFont(self.font());p.setPen(QColor('#e0e9e3' if self.isEnabled() else '#6f8077'))
        text=p.fontMetrics().elidedText(self.currentText() or 'Select…',Qt.TextElideMode.ElideRight,self.width()-44)
        p.drawText(self.rect().adjusted(13,0,-30,0),Qt.AlignmentFlag.AlignVCenter,text)
        x,y=self.width()-17,self.height()/2
        p.setPen(QPen(QColor('#91a299'),1.5))
        p.drawLine(QPointF(x-4,y-2),QPointF(x,y+2));p.drawLine(QPointF(x,y+2),QPointF(x+4,y-2))

    def showPopup(self):
        if not self.count(): return
        if self.popup:
            self.popup.close();self.popup.deleteLater()
        popup=QFrame(self,Qt.WindowType.Popup)
        self.popup=popup
        popup.setObjectName('choicePopup')
        popup.setStyleSheet('QFrame#choicePopup { background: #1a2422; border: 1px solid #41534a; border-radius: 12px; } QLabel { background: transparent; color: #91a99b; font-size: 12px; padding: 5px 10px; } QListWidget { background: transparent; border: none; outline: none; padding: 0; }')
        layout=QVBoxLayout(popup);layout.setContentsMargins(7,7,7,7);layout.setSpacing(5)
        title=QLabel(self.popup_title);layout.addWidget(title)
        items=QListWidget();items.setItemDelegate(ChoiceDelegate(items));layout.addWidget(items)
        items.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        for i in range(self.count()):
            item=QListWidgetItem(self.itemText(i));item.setData(Qt.ItemDataRole.UserRole,i)
            item.setData(Qt.ItemDataRole.UserRole+1,i==self.currentIndex());items.addItem(item)
        items.setCurrentRow(self.currentIndex())
        def select(item):
            self.setCurrentIndex(item.data(Qt.ItemDataRole.UserRole));popup.close();self.setFocus()
            self.activated.emit(self.currentIndex())
        items.itemClicked.connect(select);items.itemActivated.connect(select)
        width=max(self.width(),270);height=min(self.count()*42+57,370)
        screen=self.screen().availableGeometry()
        point=self.mapToGlobal(QPoint(0,self.height()+6))
        point.setX(min(point.x(),screen.right()-width))
        if point.y()+height>screen.bottom():point.setY(self.mapToGlobal(QPoint(0,0)).y()-height-6)
        popup.setGeometry(point.x(),point.y(),width,height);popup.show();items.setFocus()

    def hidePopup(self):
        if self.popup:self.popup.close()

    def wheelEvent(self,event):
        event.ignore()


class Toggle(QCheckBox):
    def __init__(self,text='',parent=None):
        super().__init__(text,parent);self.setMinimumHeight(36)
        self.setCursor(Qt.CursorShape.PointingHandCursor)

    def sizeHint(self):
        return QSize(self.fontMetrics().horizontalAdvance(self.text())+64,38)

    def hitButton(self,pos):
        return self.rect().contains(pos)

    def paintEvent(self,event):
        p=QPainter(self);p.setRenderHint(QPainter.RenderHint.Antialiasing)
        y=(self.height()-22)/2
        p.setPen(Qt.PenStyle.NoPen);p.setBrush(QColor('#9ed8b9' if self.isChecked() else '#3b4943'))
        p.drawRoundedRect(QRectF(0,y,38,22),11,11)
        p.setBrush(QColor('#152820' if self.isChecked() else '#c0cdc5'))
        p.drawEllipse(QRectF(19 if self.isChecked() else 3,y+3,16,16))
        p.setFont(self.font());p.setPen(QColor('#e0e8e2' if self.isEnabled() else '#718177'))
        p.drawText(self.rect().adjusted(51,0,0,0),Qt.AlignmentFlag.AlignVCenter,self.text())
        if self.hasFocus():
            p.setPen(QColor('#a5d8bc'));p.setBrush(Qt.BrushStyle.NoBrush)
            p.drawRoundedRect(QRectF(0,y-3,41,28),12,12)


def text_label(text, role=None):
    result=QLabel(text);result.setTextFormat(Qt.TextFormat.PlainText)
    if role:result.setObjectName(role)
    result.setWordWrap(True)
    return result


def card(title, description=''):
    frame=QFrame();frame.setObjectName('settingsCard')
    layout=QVBoxLayout(frame);layout.setContentsMargins(24,22,24,22);layout.setSpacing(14)
    layout.addWidget(text_label(title,'connectionTitle'))
    if description:layout.addWidget(text_label(description,'muted'))
    return frame,layout


def centered_content(scroll):
    shell=QWidget();row=QHBoxLayout(shell);row.setContentsMargins(32,30,32,30)
    body=QWidget();body.setMaximumWidth(960);body.setSizePolicy(QSizePolicy.Policy.Expanding,QSizePolicy.Policy.Preferred)
    row.addStretch(1);row.addWidget(body,20);row.addStretch(1)
    layout=QVBoxLayout(body);layout.setContentsMargins(0,0,0,0);layout.setSpacing(20)
    scroll.setWidgetResizable(True);scroll.setWidget(shell)
    return layout
